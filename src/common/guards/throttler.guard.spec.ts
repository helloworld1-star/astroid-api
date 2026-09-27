import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { ThrottlerOptions, ThrottlerRequest } from '@nestjs/throttler';
import { AstroidThrottlerGuard } from './throttler.guard';
import { createThrottlerOptions, ThrottlerConfig } from '../../config/throttler.config';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';


const BLOCKED: ThrottlerStorageRecord = {
  totalHits: 11,
  timeToExpire: 30,
  isBlocked: true,
  timeToBlockExpire: 30,
};
type ThrottlerStorageRecord = Awaited<ReturnType<AstroidThrottlerGuard['storageService']['increment']>>;

const CONFIG: ThrottlerConfig = { windowSeconds: 60, apiLimit: 120, authLimit: 10 };

const UNBLOCKED: ThrottlerStorageRecord = {
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
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

async function prepare(opts: { tier?: ThrottleTier; increment?: ReturnType<typeof vi.fn>; user?: Record<string, unknown> } = {}) {
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
  const context = buildContext({ ip: '203.0.113.7', headers: {}, user: opts.user }, response);
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

describe('AstroidThrottlerGuard Dynamic Tier Support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adjusts limits based on user tier (enterprise)', async () => {
    const { increment, call, response } = await prepare({ user: { organizationId: 'org-1', tier: 'enterprise' } });
    await expect(call(throttlerNamed('api'))).resolves.toBe(true);
    expect(increment).toHaveBeenCalledWith(
      expect.any(String),
      60_000,
      50,
      60_000,
      'api',
    );
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit-api', 50);
  });

  it('adjusts limits based on user tier (pro)', async () => {
    const { increment, call, response } = await prepare({ user: { organizationId: 'org-1', tier: 'pro' } });
    await expect(call(throttlerNamed('api'))).resolves.toBe(true);
    expect(increment).toHaveBeenCalledWith(
      expect.any(String),
      60_000,
      20,
      60_000,
      'api',
    );
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit-api', 20);
  });
});
