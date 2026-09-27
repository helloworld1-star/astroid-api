import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ErrorCode } from '../constants/error-codes';
import { SlidingWindowThrottlerGuard } from './sliding-window-throttler.guard';

const exec = vi.fn();
const chain = { zremrangebyscore: vi.fn().mockReturnThis(), zcard: vi.fn().mockReturnThis(), zadd: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(), exec };

function makeContext(user?: Record<string, string>, ip = '127.0.0.1', headers: Record<string, string> = {}) {
  const response = { setHeader: vi.fn() };
  const request = { user, ip, headers };
  const handler = vi.fn();
  const context = {
    getHandler: () => handler,
    getClass: () => class AgentController {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  };
  return { context, response, request };
}

function makeGuard(redis: Record<string, unknown>, limit = 2) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
  const config = { get: vi.fn((key: string, fallback: unknown) => key === 'rateLimit.maxRequests' ? limit : fallback) };
  const guard = new SlidingWindowThrottlerGuard(reflector as never, config as never);
  Object.assign(guard, { redis });
  return guard;
}

describe('SlidingWindowThrottlerGuard', () => {
  beforeEach(() => { vi.clearAllMocks(); exec.mockResolvedValue([[null, 0], [null, 0], [null, 1], [null, 1]]); });

  it('allows requests and emits standard rate-limit headers', async () => {
    const { context, response } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({ multi: () => chain });
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(chain.zremrangebyscore).toHaveBeenCalled();
    expect(chain.zcard).toHaveBeenCalled();
    expect(chain.zadd).toHaveBeenCalled();
    expect(chain.expire).toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 2);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 1);
  });

  it('rejects an exhausted window with Retry-After', async () => {
    exec.mockResolvedValue([[null, 0], [null, 2], [null, 1], [null, 1]]);
    const { context, response } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({ multi: () => chain });
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  it('uses organization scope for authenticated users and IP scope otherwise', async () => {
    const redis = { multi: vi.fn(() => chain) };
    const authenticated = makeContext({ organizationId: 'org-1' });
    const anonymous = makeContext(undefined, '192.0.2.1');
    const guard = makeGuard(redis);
    await guard.canActivate(authenticated.context as never);
    await guard.canActivate(anonymous.context as never);
    expect(chain.zadd.mock.calls[0][1]).toBeGreaterThan(0);
    expect(redis.multi).toHaveBeenCalledTimes(2);
  });

  it('supports dynamic tiers like enterprise and pro limits', async () => {
    const { context, response } = makeContext({ organizationId: 'org-ent', tier: 'enterprise' });
    const guard = makeGuard({ multi: () => chain }, 120);
    await guard.canActivate(context as never);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 1000);
  });

  it('fails open and logs when Redis is unavailable', async () => {
    const logger = { error: vi.fn() };
    const { context, response } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({ multi: () => { throw new Error('offline'); } });
    Object.assign(guard, { logger });
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('allowing request'));
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 2);
  });
});
