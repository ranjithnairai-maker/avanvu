/** The public API (SPEC §11). Routes live under /v1; every handler goes through auth, rate limits and errors. */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { AvanvuError, ERROR_CODES } from '@avanvu/core';
import { LIMITS } from '../http/ratelimit';
import type { AppDeps, AppEnv } from './context';
import { registerBasicRoutes } from './routes/basic';
import { registerInternalRoutes } from './internal';
import { registerAccountRoutes } from './routes/account';
import { registerEventRoutes } from './routes/events';
import { constantTimeEqual, parseRevenueCatWebhook, recordRevenueCatEvent } from '../domain/entitlements';
import { registerIntakeRoutes } from './routes/intake';
import { registerSessionRoutes } from './routes/sessions';

async function hashSubject(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Request id (propagated to tasks and the worker), scoped logger, access log without bodies.
  app.use('*', async (c, next) => {
    const rid = c.req.header('x-request-id');
    const requestId =
      rid && /^[A-Za-z0-9_-]{8,64}$/.test(rid) ? rid : `req_${crypto.randomUUID().replaceAll('-', '')}`;
    const logger = deps.logger.child({ request_id: requestId });
    c.set('requestId', requestId);
    c.set('logger', logger);
    c.header('x-request-id', requestId);
    const started = Date.now();
    await next();
    logger.info('http_request', {
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Date.now() - started,
    });
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'req_unknown';
    const e =
      err instanceof AvanvuError ? err : new AvanvuError('INTERNAL', 'Something went wrong. Try again.');
    // Vendor and internal error text is never returned or logged: only the code.
    c.get('logger')?.[e.http >= 500 ? 'error' : 'warn']('request_failed', { error_code: e.code });
    if (e.retryAfterMs !== undefined) c.header('Retry-After', String(Math.ceil(e.retryAfterMs / 1000)));
    return c.json(e.toBody(requestId), ERROR_CODES[e.code].http as 400);
  });

  app.notFound((c) =>
    c.json(new AvanvuError('NOT_FOUND', 'Not found.').toBody(c.get('requestId') ?? 'req_unknown'), 404),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));

  // RevenueCat webhook: triggers a sync, never trusted for state. Duplicates are ignored by vendor id.
  app.post('/webhooks/revenuecat', async (c) => {
    if (!constantTimeEqual(c.req.header('Authorization') ?? '', deps.webhookAuth)) {
      return c.json(new AvanvuError('UNAUTHENTICATED', 'Not allowed.').toBody(c.get('requestId')), 401);
    }
    const ev = parseRevenueCatWebhook(await c.req.json().catch(() => null));
    if (!ev) return c.json({ ok: true, ignored: true });
    const outboxId = await recordRevenueCatEvent(deps.db, ev);
    if (outboxId) await deps.dispatcher.dispatchAfterCommit([outboxId]);
    return c.json({ ok: true });
  });

  // Authenticated API.
  const api = new Hono<AppEnv>();
  api.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
      await deps.limiter.enforce(await hashSubject(ip), LIMITS.ipRequests);
      const { userId } = await deps.auth.authenticate(c.req.header('Authorization'));
      c.set('userId', userId);
      await deps.accounts.check(userId); // creates the account on first use; ACCOUNT_DELETED when deleted
      await next();
    }),
  );
  registerBasicRoutes(api, deps);
  registerEventRoutes(api, deps);
  registerIntakeRoutes(api, deps, {
    db: deps.db,
    sealer: deps.sealer,
    idem: deps.idem,
    llm: deps.llm,
    logger: deps.logger,
    now: deps.now,
    intakeTimeoutMs: deps.intakeTimeoutMs,
  });
  registerSessionRoutes(api, deps);
  registerAccountRoutes(api, deps);
  app.route('/v1', api);
  if (deps.internal) registerInternalRoutes(app, { ...deps.internal, dispatcher: deps.dispatcher });
  return app;
}
