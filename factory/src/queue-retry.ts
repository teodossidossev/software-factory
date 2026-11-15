// The run queue's next try of a start that could not fetch its base (fetch_failed: the network is
// gone): the schedule of the tries, whether an entry waits for its next one, and the one
// notification at the first failure. The queue (src/queue.ts) keeps such an entry in its place
// with retry_at and retries.
import { type Notification, withNotifyMode } from './notify.js';
import type { NotifyMode } from './registry.js';

// The start error the queue tries again instead of failing: the base could not be fetched.
export const RETRY_CODE = 'fetch_failed';
// The wait before the next try of a start that could not fetch: 5 minutes after the first failure,
// then 10, then 15 after every later one.
const RETRY_MINUTES = [5, 10, 15] as const;

// The wait in ms after the retries-th failed fetch (1-based).
export function retryDelayMs(retries: number): number {
  return RETRY_MINUTES[Math.min(Math.max(retries, 1), RETRY_MINUTES.length) - 1]! * 60_000;
}

// Whether the entry waits for the next try of a start that could not fetch (retry_at ahead of now).
export function retryPending(entry: { retry_at?: string | undefined }, now: number): boolean {
  return entry.retry_at !== undefined && Date.parse(entry.retry_at) > now;
}

// The one notification of a queued start that could not fetch, at its first failure, as the
// workspace's notify setting has it (brief: ntfy gets "<workspace> · fetch_failed"; off: none).
export function fetchRetryNotification(workspace: string, ticket: string, base: string, mode: NotifyMode): Notification | undefined {
  const full: Notification = { title: `${ticket}: start failed`, body: `${ticket} could not fetch ${base}; the queue tries again`, priority: 'default', tags: 'warning' };
  return withNotifyMode(full, mode, `${workspace} · ${RETRY_CODE}`);
}
