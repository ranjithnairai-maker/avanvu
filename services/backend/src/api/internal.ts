/**
 * Internal endpoints (SPEC §11.2) called by Cloud Scheduler with an OIDC token: the outbox sweeper (every
 * minute) and the scheduler tick (every five minutes). Neither is reachable with an athlete token.
 */
import type { Hono } from 'hono';
import { AvanvuError } from '@avanvu/core';
import type { OutboxDispatcher } from '../domain/outbox';
import type { Scheduler } from '../domain/scheduler';
import type { TaskAuth } from '../worker/taskauth';

export function registerInternalRoutes(
  app: Hono<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  deps: { auth: TaskAuth; dispatcher: OutboxDispatcher; scheduler: Scheduler },
): void {
  app.use('/internal/*', async (c, next) => {
    try {
      await deps.auth.verify(c.req.header('Authorization'));
    } catch (e) {
      const err = e instanceof AvanvuError ? e : new AvanvuError('UNAUTHENTICATED', 'Not allowed.');
      return c.json(err.toBody('internal'), 401);
    }
    await next();
  });
  app.post('/internal/outbox/sweep', async (c) => c.json({ dispatched: await deps.dispatcher.sweep() }));
  app.post('/internal/schedule/tick', async (c) => c.json(await deps.scheduler.tick()));
}
