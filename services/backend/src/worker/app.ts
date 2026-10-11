/**
 * The worker HTTP surface (SPEC §11.2): Cloud Tasks delivers here with an OIDC token. The job id in the body
 * is never authority by itself: the token is verified first, then the job is looked up and leased.
 * Non-2xx asks Cloud Tasks to retry; 200 means "done with this task".
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { AvanvuError } from '@avanvu/core';
import type { Db } from '../db/tx';
import { deliverNotification } from '../domain/push';
import type { Logger } from '../observability/logger';
import type { PushClient } from '../ports/push';
import { RenderWorker } from './render';
import type { TaskAuth } from './taskauth';

const bodySchema = z.object({ job_id: z.string().uuid() });

export interface WorkerAppDeps {
  auth: TaskAuth;
  worker: RenderWorker;
  db: Db;
  push: PushClient;
  logger: Logger;
  now: () => Date;
}

export function createWorkerApp(deps: WorkerAppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/tasks/*', async (c, next) => {
    try {
      await deps.auth.verify(c.req.header('Authorization'));
    } catch (e) {
      const err = e instanceof AvanvuError ? e : new AvanvuError('UNAUTHENTICATED', 'Not allowed.');
      return c.json(err.toBody('worker'), 401);
    }
    await next();
  });

  app.post('/tasks/render', async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const outcome = await deps.worker.process(parsed.data.job_id);
    return c.json({ result: outcome.result }, outcome.status as 200);
  });

  app.post('/tasks/push', async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const outcome = await deliverNotification(deps.db, deps.push, parsed.data.job_id, deps.now());
    // A push that reached no device is retried by the queue (up to its attempt limit).
    return c.json({ result: outcome }, outcome === 'failed' ? 503 : 200);
  });

  app.onError((err, c) => {
    deps.logger.error('worker_error', { error_code: err instanceof AvanvuError ? err.code : 'INTERNAL' });
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
