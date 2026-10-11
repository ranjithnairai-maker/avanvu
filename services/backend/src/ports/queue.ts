/**
 * Task queue port (D-02, SPEC §9.3). Production is Google Cloud Tasks with OIDC delivery to the worker;
 * task names are unique so a second enqueue of the same dispatch is a no-op. The Cloud Tasks adapter is an
 * external-API integration (placeholder until the GCP project exists). InProcessQueue lets tests and local
 * development deliver tasks, including deliberate duplicates.
 */
import { AvanvuError } from '@avanvu/core';

export type QueueName = 'render' | 'jobs';

export interface TaskSpec {
  queue: QueueName;
  /** `{kind}-{job_id}-{dispatch_generation}`: uniqueness makes duplicate enqueues harmless. */
  name: string;
  /** Worker path, for example `/tasks/render`. */
  path: string;
  /** Ids only. Never athlete text, prompts, tokens or signed URLs (CLAUDE.md non-negotiable 3). */
  body: Record<string, string | number>;
}

export interface TaskQueue {
  /** Returns false when a task with this name already exists. */
  enqueue(task: TaskSpec): Promise<boolean>;
}

export class UnconfiguredQueue implements TaskQueue {
  async enqueue(): Promise<boolean> {
    throw new AvanvuError('UPSTREAM_UNAVAILABLE', 'The task queue is not configured yet.');
  }
}

export type TaskHandler = (task: TaskSpec) => Promise<{ status: number }>;

export class InProcessQueue implements TaskQueue {
  readonly tasks: TaskSpec[] = [];
  private readonly names = new Set<string>();
  /** Test hook: make the next enqueue fail, like a Cloud Tasks outage. */
  failNext = 0;

  async enqueue(task: TaskSpec): Promise<boolean> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new AvanvuError('UPSTREAM_UNAVAILABLE', 'queue unavailable');
    }
    if (this.names.has(task.name)) return false;
    this.names.add(task.name);
    this.tasks.push(task);
    return true;
  }

  /**
   * Deliver every queued task to the handler. A non-2xx status leaves the task queued for a retry
   * (up to `maxAttempts`), like Cloud Tasks. `duplicate` delivers each task twice.
   */
  async drain(
    handler: TaskHandler,
    opts: { duplicate?: boolean; maxAttempts?: number } = {},
  ): Promise<number> {
    let delivered = 0;
    const max = opts.maxAttempts ?? 3;
    while (this.tasks.length > 0) {
      const task = this.tasks.shift() as TaskSpec;
      for (let attempt = 1; attempt <= max; attempt++) {
        const res = await handler(task);
        delivered++;
        if (opts.duplicate) {
          await handler(task);
          delivered++;
        }
        if (res.status >= 200 && res.status < 300) break;
      }
    }
    return delivered;
  }
}
