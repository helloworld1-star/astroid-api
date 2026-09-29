import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { ThrottlerOptions, ThrottlerRequest } from '@nestjs/throttler';

import { AstroidThrottlerGuard } from './throttler.guard';
import { createThrottlerOptions, ThrottlerConfig } from '../../config/throttler.config';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';

/** Shape returned by `ThrottlerStorage#increment` (not re-exported by the lib). */
type ThrottlerStorageRecord = Awaited<ReturnType<AstroidThrottlerGuard['storageService']['increment']>>;

const CONFIG: ThrottlerConfig = { windowSeconds: 60, apiLimit: 120, authLimit: 10 };

const UNBLOCKED: ThrottlerStorageRecord = {
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
};

const BLOCKED: ThrottlerStorageRecord = {
  totalHits: 11,
  timeToExpire: 30,
  isBlocked: true,
  timeToBlockExpire: 30,
};

type MockResponse = { header: ReturnType<typeof vi.fn> };

function buildContext(request: Record<string, unknown> = { ip: '203.0.113.7', headers: {} }, response: MockResponse = { header: vi.fn() }) {
  const handler = () => undefined;
  return {
    getHandler: () => handler,
    getClass: () => class TransactionController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function throttlerNamed(name: string): ThrottlerOptions {
  return { name, ttl: 60_000, limit: 10 };
}

async function prepare(opts: { tier?: ThrottleTier; increment?: ReturnType<typeof vi.fn> } = {}) {
  const increment = opts.increment ?? vi.fn().mockResolvedValue(UNBLOCKED);
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === THROTTLE_TIER_KEY ? opts.tier : undefined)),
  };
  const guard = new AstroidThrottlerGuard(
    createThrottlerOptions(CONFIG),
    { increment } as never,
    reflector as never,
  );
  await guard.onModuleInit();

  const response: MockResponse = { header: vi.fn() };
  const context = buildContext({ ip: '203.0.113.7', headers: {} }, response);
  const { getTracker, generateKey } = (
    guard as unknown as {
      commonOptions: Pick<ThrottlerRequest, 'getTracker' | 'generateKey'>;
    }
  ).commonOptions;

  const call = (throttler: ThrottlerOptions) =>
    guard['handleRequest']({
      context,
      limit: 10,
      ttl: 60_000,
      throttler,
      blockDuration: 60_000,
      getTracker,
      generateKey,
    } as ThrottlerRequest);

  return { guard, increment, reflector, context, response, call };
}

describe('AstroidThrottlerGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tier routing', () => {
    it('ignores the throttler whose name does not match the route tier', async () => {
      const { increment, call } = await prepare(); // no tier set -> defaults to 'api'

      await expect(call(throttlerNamed('auth'))).resolves.toBe(true);

      expect(increment).not.toHaveBeenCalled();
    });

    it('enforces the throttler whose name matches the default `api` tier', async () => {
      const { increment, call } = await prepare();

      await expect(call(throttlerNamed('api'))).resolves.toBe(true);

      expect(increment).toHaveBeenCalledTimes(1);
    });

    it('enforces only `auth` for routes declared with the auth tier', async () => {
      const { increment, call } = await prepare({ tier: 'auth' });

      await expect(call(throttlerNamed('api'))).resolves.toBe(true);
      expect(increment).not.toHaveBeenCalled();

      await expect(call(throttlerNamed('auth'))).resolves.toBe(true);
      expect(increment).toHaveBeenCalledTimes(1);
    });

    it('passes the resolved tier limits down to the storage', async () => {
      const { increment, call } = await prepare({ tier: 'auth' });

      await call(throttlerNamed('auth'));

      expect(increment).toHaveBeenCalledWith(
        expect.any(String),
        60_000,
        10,
        60_000,
        'auth',
      );
    });
  });

  describe('tracking', () => {
    it('falls back to the client IP for anonymous requests', async () => {
      const { guard } = await prepare();

      const tracker = await guard['getTracker']({ ip: '203.0.113.7', headers: {} });

      expect(tracker).toBe('ip:203.0.113.7');
    });

    it('scopes the counter to the organization when a user is authenticated', async () => {
      const { guard } = await prepare();

      const tracker = await guard['getTracker']({
        ip: '203.0.113.7',
        headers: {},
        user: { organizationId: 'org-9' },
      });

      expect(tracker).toBe('org:org-9');
    });

    it('prefers the forwarded-for header over the socket address', async () => {
      const { guard } = await prepare();

      const tracker = await guard['getTracker']({
        headers: { 'x-forwarded-for': '198.51.100.4' },
      });

      expect(tracker).toBe('ip:198.51.100.4');
    });
  });

  describe('allowed responses', () => {
    it('emits the standard X-RateLimit headers', async () => {
      const { response, call } = await prepare();

      await call(throttlerNamed('api'));

      expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
      expect(response.header).toHaveBeenCalledWith('X-RateLimit-Remaining', 9);
      expect(response.header).toHaveBeenCalledWith('X-RateLimit-Reset', 60);
      expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit-api', 10);
      expect(response.header).toHaveBeenCalledWith('X-RateLimit-Remaining-api', 9);
      expect(response.header).toHaveBeenCalledWith('X-RateLimit-Reset-api', 60);
    });
  });

  describe('handleRequest throttled responses', () => {
    it('throws a 429 exception and sets Retry-After when the client is blocked', async () => {
      const { response, call } = await prepare({ increment: vi.fn().mockResolvedValue(BLOCKED) });

      await expect(call(throttlerNamed('api'))).rejects.toMatchObject({ status: 429 });

      expect(response.header).toHaveBeenCalledWith('Retry-After-api', 30);
      expect(response.header).not.toHaveBeenCalledWith(
        'X-RateLimit-Remaining-api',
        expect.anything(),
      );
    });

    it('exposes getStatus() so the exception filter can render the 429 envelope', async () => {
      const { call } = await prepare({ increment: vi.fn().mockResolvedValue(BLOCKED) });

      const error = await call(throttlerNamed('api')).catch(
        (e: Error & { getStatus: () => number }) => e,
      );

      expect((error as { getStatus: () => number }).getStatus()).toBe(429);
    });
  });
});
