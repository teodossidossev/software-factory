// The plan check of a queued ticket as the run queue sees it (src/queue.ts): PlanCheck,
// PLAN_NOT_CHECKED, planReason and planHold.
import { FactoryError } from './errors.js';
import type { QueueEntry } from './queue-store.js';

// The Task check of a queued ticket's current Task file: ready, not_ready, failed, checking
// (pending or running), none, or not_needed (no check of this version, and checkNeed says
// it needs none), with its blocker and major counts.
export interface PlanCheck {
  state: 'ready' | 'not_ready' | 'failed' | 'checking' | 'none' | 'not_needed';
  blockers: number;
  majors: number;
}

// The reason of a plan with no check of its current Task file; a pass asks for its check.
export const PLAN_NOT_CHECKED = 'plan not checked';

// Why the scheduler skips a queued ticket for its plan, as its card says it; null when ready or not
// needed.
export function planReason(plan: PlanCheck): string | null {
  switch (plan.state) {
    case 'ready':
    case 'not_needed':
      return null;
    case 'not_ready':
      return `plan not ready: ${plan.blockers} blocker, ${plan.majors} major`;
    case 'failed':
      return 'plan check failed';
    case 'checking':
      return 'plan being checked';
    case 'none':
      return PLAN_NOT_CHECKED;
  }
}

// Why the entry's plan holds it (null: it does not): forced, no plan check, ready or not
// needed. A plan check that fails counts as not checked.
export async function planHold(planCheck: ((workspace: string, ticket: string) => Promise<PlanCheck>) | undefined, entry: QueueEntry): Promise<string | null> {
  if (entry.force === true || planCheck === undefined) {
    return null;
  }
  const plan = await planCheck(entry.workspace, entry.ticket).catch((error: unknown): PlanCheck => {
    if (!(error instanceof FactoryError)) {
      console.error(error);
    }
    return { state: 'none', blockers: 0, majors: 0 };
  });
  return planReason(plan);
}
