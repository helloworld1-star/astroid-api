import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  THROTTLE_TIER_KEY,
  ThrottleTier,
} from '../decorators/throttle-tier.decorator';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

/**
 * Rate-limit guard with two tiers and dynamic tier limit support. Every route is evaluated against both named
 * throttlers ('api' = 120/min, 'auth' = 10/min by default), but each throttler
 * only counts a request when its name matches the route's tier — so the auth
 * endpoints (marked `@ThrottleTierDecorator('auth')`) get the stricter limit
 * while everything else falls back to the `api` tier.
 *
 * The counter is scoped to the authenticated organization or API key, falling back to the
 * client IP for anonymous requests.
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  /**
   * Enforce a named throttler only when it matches the route's declared tier.
   * Routes without an explicit tier default to `api`.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler, ttl, blockDuration } = requestProps;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser & { tier?: string; rateLimit?: number } }>();
    const response = context.switchToHttp().getResponse<Response>();

    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';

    // This named throttler does not govern this route's tier — do not count it.
    if (throttler.name !== routeTier) {
      return true;
    }

    // Dynamic tier limit support based on authenticated user/agent tier or custom limit
    let limit = throttler.limit;
    const userTier = request.user?.tier;
    if (userTier === 'enterprise' || request.user?.rateLimit === 1000) {
      limit = Math.max(limit, 1000);
    } else if (userTier === 'pro' || request.user?.rateLimit === 300) {
      limit = Math.max(limit, 300);
    } else if (typeof request.user?.rateLimit === 'number') {
      limit = request.user.rateLimit;
    }

    const tracker = await this.getTracker(request);
    const key = this.generateKey(context, tracker, throttler.name);
    const ttlMillis = ttl;

    try {
      const storageResult = await this.storageService.increment(
        key,
        ttlMillis,
        limit,
        blockDuration,
        throttler.name,
      );

      const remaining = Math.max(0, limit - storageResult.totalHits);
      const resetSeconds = Math.ceil(storageResult.timeToExpire);

      if (response && typeof response.setHeader === 'function') {
        response.setHeader(`X-RateLimit-Limit`, limit);
        response.setHeader(`X-RateLimit-Remaining`, remaining);
        response.setHeader(`X-RateLimit-Reset`, resetSeconds);
        response.setHeader(`X-RateLimit-Limit-${throttler.name}`, limit);
        response.setHeader(`X-RateLimit-Remaining-${throttler.name}`, remaining);
        response.setHeader(`X-RateLimit-Reset-${throttler.name}`, resetSeconds);
      }

      if (storageResult.isBlocked) {
        if (response && typeof response.setHeader === 'function') {
          response.setHeader('Retry-After', Math.max(1, Math.ceil(storageResult.timeToBlockExpire)));
        }
        throw new DomainException(
          ErrorCode.RATE_LIMITED,
          'Rate limit exceeded',
          { limit, ttl: ttlMillis }
        );
      }

      return true;
    } catch (error) {
      if (error instanceof DomainException && error.code === ErrorCode.RATE_LIMITED) {
        throw error;
      }
      // Redis / storage failure fallback: allow request gracefully
      if (response && typeof response.setHeader === 'function') {
        response.setHeader(`X-RateLimit-Limit`, limit);
        response.setHeader(`X-RateLimit-Remaining`, limit);
      }
      return true;
    }
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & { user?: AuthenticatedUser };
    const org = request.user?.organizationId;
    if (org) {
      return `org:${org}`;
    }
    const apiKeyId = request.user?.apiKeyId;
    if (apiKeyId) {
      return `key:${apiKeyId}`;
    }
    const forwarded = request.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ??
      request.ip ??
      request.socket?.remoteAddress ??
      'anonymous';
    return `ip:${ip}`;
  }
}
