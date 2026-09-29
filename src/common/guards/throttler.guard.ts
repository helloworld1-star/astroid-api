import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  THROTTLE_TIER_KEY,
  ThrottleTier,
} from '../decorators/throttle-tier.decorator';

/**
 * Rate-limit guard with dynamic tier support. Every route is evaluated against both named
 * throttlers ('api' and 'auth'), but each throttler only counts a request when its name matches
 * the route's tier. Supports dynamic tier-based rate limits extracted from the authenticated user,
 * API key tier, or subscription level, with fallback to default or IP-based limits.
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  /**
   * Enforce a named throttler only when it matches the route's declared tier.
   * Routes without an explicit tier default to `api`.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';

    // This named throttler does not govern this route's tier — do not count it.
    if (throttler.name !== routeTier) {
      return true;
    }

    // Dynamic limit adjustment based on tier / subscription level / API key tier
    const dynamicLimit = this.getDynamicLimit(request, routeTier, throttler.limit);
    const dynamicProps: ThrottlerRequest = {
      ...requestProps,
      limit: dynamicLimit,
    };

    return super.handleRequest(dynamicProps);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & { user?: AuthenticatedUser };
    const org = request.user?.organizationId;
    if (org) {
      return `org:${org}`;
    }
    const forwarded = request.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ??
      request.ip ??
      request.socket?.remoteAddress ??
      'anonymous';
    return `ip:${ip}`;
  }

  protected async getLimitResponseDetail(
    context: Parameters<ThrottlerGuard['getLimitResponseDetail']>[0],
    tracker: string,
    incrementResult: Parameters<ThrottlerGuard['getLimitResponseDetail']>[2],
    throttler: Parameters<ThrottlerGuard['getLimitResponseDetail']>[3],
  ): Promise<ThrottlerLimitDetail> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';
    const limit = this.getDynamicLimit(request, routeTier, throttler.limit);
    const detail = await super.getLimitResponseDetail(context, tracker, incrementResult, throttler);
    return {
      ...detail,
      limit,
    };
  }

  private getDynamicLimit(request: Request & { user?: AuthenticatedUser }, routeTier: string, defaultLimit: number): number {
    const user = request.user;
    if (!user) {
      return defaultLimit;
    }

    // Check for explicit tier or subscription metadata on user / API key / organization
    const userTier = (user as Record<string, unknown>).tier ?? (user as Record<string, unknown>).subscriptionTier;
    if (typeof userTier === 'string') {
      const lower = userTier.toLowerCase();
      if (lower === 'enterprise' || lower === 'unlimited') {
        return 1000;
      }
      if (lower === 'pro' || lower === 'growth') {
        return 300;
      }
      if (lower === 'free' || lower === 'basic') {
        return 60;
      }
    }

    // Check explicit rate limit override on user object
    const userRateLimit = (user as Record<string, unknown>).rateLimit;
    if (typeof userRateLimit === 'number') {
      return userRateLimit;
    }

    if (routeTier === 'auth') {
      return 20;
    }

    return defaultLimit;
  }
}
