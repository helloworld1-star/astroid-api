import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';
import { extractApiKeyFromRequest } from '../helpers/extract-api-key';

export const SLIDING_WINDOW_LIMIT_KEY = 'astroid:slidingWindowLimit';
export const SlidingWindowLimit = (limit: number, windowSeconds = 60) =>
  Reflector.createDecorator<{ limit: number; windowSeconds: number }>()({ limit, windowSeconds });

@Injectable()
export class SlidingWindowThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(SlidingWindowThrottlerGuard.name);
  private readonly redis: Redis;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.defaultLimit = config.get<number>('rateLimit.maxRequests', 120);
    this.defaultWindowSeconds = config.get<number>('rateLimit.windowSeconds', 60);
    const host = config.get<string>('redis.host', 'localhost');
    const port = config.get<number>('redis.port', 6379);
    const password = config.get<string>('redis.password', '');
    const db = config.get<number>('redis.db', 0);
    this.redis = new Redis({ host, port, password: password || undefined, db, lazyConnect: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse<Response>();
    const configured = this.reflector.getAllAndOverride<{ limit: number; windowSeconds: number }>(
      SLIDING_WINDOW_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    
    const tier = this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'api';

    let tierLimit = this.defaultLimit;
    if (tier === 'auth') {
      tierLimit = 10;
    } else if (request.user?.tier === 'enterprise' || request.user?.subscriptionLevel === 'enterprise') {
      tierLimit = 1000;
    } else if (request.user?.tier === 'pro' || request.user?.subscriptionLevel === 'pro') {
      tierLimit = 300;
    }

    const limit = configured?.limit ?? tierLimit;
    const windowSeconds = configured?.windowSeconds ?? this.defaultWindowSeconds;
    const key = this.keyFor(request, context);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    response.setHeader('X-RateLimit-Limit', limit);
    response.setHeader('X-RateLimit-Reset', Math.ceil((now + windowSeconds * 1000) / 1000));

    try {
      const member = `${now}:${Math.random().toString(36).slice(2)}`;
      const result = await this.redis
        .multi()
        .zremrangebyscore(key, 0, windowStart)
        .zcard(key)
        .zadd(key, now, member)
        .expire(key, windowSeconds)
        .exec();
      const count = Number(result?.[1]?.[1] ?? 0);
      const remaining = Math.max(0, limit - count - 1);
      response.setHeader('X-RateLimit-Remaining', remaining);
      if (count >= limit) {
        response.setHeader('Retry-After', Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000)));
        throw new DomainException(ErrorCode.RATE_LIMITED, 'Rate limit exceeded', { limit, windowSeconds });
      }
      return true;
    } catch (error) {
      if (error instanceof DomainException && error.code === ErrorCode.RATE_LIMITED) throw error;
      this.logger.error(`Sliding-window Redis check failed; allowing request: ${(error as Error).message}`);
      response.setHeader('X-RateLimit-Remaining', limit);
      return true;
    }
  }

  private keyFor(request: Request & { user?: AuthenticatedUser }, context: ExecutionContext): string {
    const scope = this.clientScope(request);
    const tier = this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'api';
    return `rate-limit:${tier}:${scope}:${context.getClass().name}:${context.getHandler().name}`;
  }

  private clientScope(request: Request & { user?: AuthenticatedUser }): string {
    const organizationId = request.user?.organizationId;
    if (organizationId) {
      return `org:${organizationId}`;
    }

    const apiKey = extractApiKeyFromRequest(request);
    if (apiKey) {
      return `key:${createHash('sha256').update(apiKey).digest('hex')}`;
    }

    const forwarded = request.headers?.['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.ip ?? 'anonymous';
    return `ip:${ip}`;
  }
}
