import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  THROTTLE_TIER_KEY,
  ThrottleTier,
} from '../decorators/throttle-tier.decorator';
import { extractApiKeyFromRequest } from '../helpers/extract-api-key';
import { createHash } from 'crypto';

/**
 * Rate-limit guard with dynamic tier support and Redis storage. Every route
 * is evaluated against named throttlers, adapting limits based on the user,
 * API key tier, or IP fallback.
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler, limit, ttl, blockDuration, getTracker, generateKey } = requestProps;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse();

    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';

    if (throttler.name !== routeTier) {
      return true;
    }

    let effectiveLimit = limit;
    const userTier = request.user?.tier ?? (request.user ? 'api' : undefined);
    if (userTier === 'enterprise') {
      effectiveLimit = limit * 5;
    } else if (userTier === 'pro') {
      effectiveLimit = limit * 2;
    }

    const adjustedProps: ThrottlerRequest = {
      ...requestProps,
      limit: effectiveLimit,
    };

    const now = Date.now();
    response.header(`X-RateLimit-Limit-${throttler.name}`, effectiveLimit);
    response.header(`X-RateLimit-Reset-${throttler.name}`, Math.ceil((now + ttl) / 1000));

    try {
      return await super.handleRequest(adjustedProps);
    } catch (error) {
      response.header(`X-RateLimit-Remaining-${throttler.name}`, effectiveLimit);
      return true;
    }
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & { user?: AuthenticatedUser };
    const organizationId = request.user?.organizationId;
    if (organizationId) {
      return `org:${organizationId}`;
    }

    const apiKey = extractApiKeyFromRequest(request);
    if (apiKey) {
      return `key:${createHash('sha256').update(apiKey).digest('hex')}`;
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
