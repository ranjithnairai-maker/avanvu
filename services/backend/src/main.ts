/**
 * One image, two Cloud Run services (D-01). AVANVU_ROLE selects `api`, `worker`, or `both` (local dev).
 * SIGTERM drains in-flight requests and closes the pools.
 */
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './api/app';
import { closeDb } from './db/client';
import { UnimplementedAdaptersError, compose } from './composition';
import { createWorkerApp } from './worker/app';

async function main(): Promise<void> {
  const role = (process.env.AVANVU_ROLE ?? 'api') as 'api' | 'worker' | 'both';
  if (!['api', 'worker', 'both'].includes(role)) throw new Error('AVANVU_ROLE must be api, worker or both');
  const rt = await compose(role);
  const servers: ServerType[] = [];

  if (rt.api) {
    const port = Number(process.env.PORT ?? 8080);
    servers.push(serve({ fetch: createApp(rt.api.deps).fetch, port }));
    rt.logger.info('api_listening', { port });
  }
  if (rt.worker) {
    const port = role === 'both' ? Number(process.env.WORKER_PORT ?? 8081) : Number(process.env.PORT ?? 8080);
    servers.push(serve({ fetch: createWorkerApp(rt.worker.deps).fetch, port }));
    rt.logger.info('worker_listening', { port });
  }

  // Local development has no Cloud Tasks: deliver queued tasks to the worker over HTTP.
  if (rt.cfg.AVANVU_ENV === 'local' && rt.worker) {
    const { InProcessQueue } = await import('./ports/queue');
    const queue = rt.adapters.queue;
    if (queue instanceof InProcessQueue) {
      const base = `http://localhost:${process.env.WORKER_PORT ?? 8081}`;
      const token = process.env.LOCAL_TASK_TOKEN ?? 'local-task-token';
      setInterval(() => {
        void queue
          .drain(async (task) => {
            const res = await fetch(`${base}${task.path}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify(task.body),
            }).catch(() => null);
            return { status: res?.status ?? 503 };
          })
          .catch(() => undefined);
      }, 1000).unref();
    }
  }

  const shutdown = async () => {
    rt.logger.info('shutting_down', {});
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    if (rt.api) await closeDb(rt.api.db);
    if (rt.worker) await closeDb(rt.worker.db);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((e) => {
  // Startup failures are configuration problems with safe messages (never secrets).
  const msg =
    e instanceof UnimplementedAdaptersError ? e.message : e instanceof Error ? e.message : 'startup failed';
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
