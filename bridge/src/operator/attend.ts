// SF-007 attend: takes one approved job through the existing SF-006 sequence on
// the operator's own terminal (inside the operator console), with the operator
// at the keyboard. It refuses to run without a TTY, consumes the one pending
// approval atomically, re-verifies everything (SF-006 preflight, including the
// host-wide session gate; then prepare and run bound to the approval inside the
// per-job lock), starts Claude Code in manual permission mode on this terminal,
// asks whether /implement finished, and lets SF-006 collect.
//
// The session gate is taken inside SF-006 run, before the job is claimed. If
// another session holds it, nothing is claimed: a job not yet prepared stays as
// it was, a prepared one stays prepared, and the operator can approve it again
// later (a prepared job is then resumed, not prepared twice). The approval
// replaces the CLI's "Start ONE Claude Code session?" question; the
// end-of-session question stays. Nothing is retried.
import { createInterface } from 'node:readline/promises';
import { identify } from '../execution/process-identity.js';
import type { ExecutionService, ExecutionView, PreflightReport } from '../execution/service.js';
import { expired, isCodedError, launchRecord, type LaunchRecord, type OperatorStore } from './store.js';
import { inertLine } from './text.js';

export interface AttendDeps {
  store: OperatorStore;
  service: Pick<ExecutionService, 'preflight' | 'prepare' | 'run' | 'status'>;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
  now: () => Date;
  // Shown at the end, so the outcome stays on screen until the operator has read it.
  closePrompt: string;
}

export async function attend(deps: AttendDeps, appId: string, jobId: string): Promise<number> {
  const say = (line = '') => deps.output.write(`${line}\n`);
  const ask = async (question: string): Promise<string> => {
    const prompt = createInterface({ input: deps.input, output: deps.output, terminal: deps.isTTY });
    try {
      return (await prompt.question(`${question} `)).trim();
    } finally {
      prompt.close();
    }
  };
  const launch = (outcome: LaunchRecord['outcome'], code: string | null, message: string | null, extra: Partial<LaunchRecord> = {}) =>
    launchRecord(outcome, deps.now(), { code, message, ...extra });
  const label = `${appId}/${jobId}`;
  say(`Software Factory: approved job ${label}`);

  if (!deps.isTTY) {
    await deps.store.settleApproval(appId, jobId, undefined, 'refused', launch('refused', 'no_tty', 'There was no interactive terminal; nothing was started.'));
    say('No interactive terminal: refusing to run Claude Code headless. Nothing was started.');
    return 1;
  }

  const steps = async (): Promise<number> => {
    // Consume the one pending approval first: an atomic rename, so it is used at most once
    // and a competing attend never touches it.
    const now = deps.now();
    const pending = (await deps.store.jobState(appId, jobId)).pending;
    if (pending === undefined) {
      say('There is no pending approval for this job (cancelled, expired or already used). Nothing was started.');
      return 1;
    }
    if (expired(pending, now)) {
      await deps.store.settleApproval(appId, jobId, pending.id, 'expired', launch('refused', 'expired', 'The approval expired before it was used.'));
      await deps.store.appendEvent({ event: 'expired', app_id: appId, job_id: jobId, approval_id: pending.id }, now);
      say('The approval has expired. Nothing was started; approve the job again.');
      return 1;
    }
    const attendIdentity = (await identify(process.pid)) ?? null;
    const consumed = await deps.store.settleApproval(appId, jobId, pending.id, 'consumed', launch('started', null, null, { attend: attendIdentity }));
    if (consumed === undefined) {
      say('The approval was cancelled or used meanwhile. Nothing was started.');
      return 1;
    }
    const expected = { requestId: consumed.request_id, instructionSha256: consumed.instruction_sha256, appRepoSha256: consumed.app_repo_sha256 };
    await deps.store.appendEvent(
      { event: 'consumed', app_id: appId, job_id: jobId, request_id: consumed.request_id, instruction_sha256: consumed.instruction_sha256, approval_id: consumed.id },
      deps.now(),
    );
    say(`request ${inertLine(consumed.request_id)}`);
    say(`instruction sha256 ${consumed.instruction_sha256}`);
    say(`approved at ${consumed.approved_at}`);
    say();

    const finish = async (outcome: LaunchRecord['outcome'], code: string | null, message: string | null, finalState: string | null) => {
      await deps.store.writeLaunch(appId, jobId, { approval_id: consumed.id, ...launch(outcome, code, message, { attend: attendIdentity, final_state: finalState }) });
      await deps.store.appendEvent(
        {
          event: outcome === 'finished' ? 'finished' : outcome === 'failed' ? 'failed' : 'refused',
          app_id: appId,
          job_id: jobId,
          approval_id: consumed.id,
          ...(code ? { code } : {}),
          ...(finalState ? { final_state: finalState } : {}),
        },
        deps.now(),
      );
    };
    try {
      const report = await deps.service.preflight(appId, jobId);
      printPreflight(say, report);
      // A job prepared by an earlier approval whose launch found the session gate busy is resumed.
      const resume = report.state === 'prepared';
      if (!report.ready) {
        const busy = report.checks.some((check) => !check.ok && check.code === 'session_busy');
        await finish(
          'refused',
          busy ? 'session_busy' : 'not_ready',
          busy ? 'Another Claude session was running; nothing was started.' : 'Preflight was not ready; nothing was started.',
          null,
        );
        say(busy ? 'Another Claude session is running; nothing was started. Approve this job again when it has ended.' : 'Not ready; nothing was started.');
        return 1;
      }
      if (resume) {
        say('resuming the job prepared by an earlier approval');
      } else {
        const prepared = await deps.service.prepare(appId, jobId, expected);
        say(`prepared: ${prepared.destination} in the app repository`);
      }
      say('Starting Claude Code (manual permission mode). Answer its trust and permission prompts here.');
      say();
      // Ctrl+C belongs to Claude Code while it runs; attend waits for its exit.
      const ignore = () => undefined;
      process.on('SIGINT', ignore);
      process.on('SIGQUIT', ignore);
      let result: ExecutionView;
      try {
        result = await deps.service.run(
          appId,
          jobId,
          async () => /^y(es)?$/i.test(await ask(`Claude Code has exited. Did /implement finish its work for ${label} in that session? [y/N]`)),
          expected,
        );
      } finally {
        process.off('SIGINT', ignore);
        process.off('SIGQUIT', ignore);
      }
      say();
      say(`${label}: ${result.state}`);
      if (result.error) say(`  ${result.error.code}: ${inertLine(result.error.message)}`);
      if (result.recovery) say(`  next: ${inertLine(result.recovery)}`);
      await finish('finished', result.error?.code ?? null, null, result.state);
      return result.state === 'completed' ? 0 : 1;
    } catch (error) {
      const code = isCodedError(error) ? error.code : 'unexpected';
      const message = isCodedError(error) ? error.message : 'An unexpected error stopped the launch.';
      await finish(code === 'session_busy' ? 'refused' : 'failed', code, message.slice(0, 500), null).catch(() => undefined);
      say(`${code}: ${inertLine(message)}`);
      say('Nothing more was started.');
      return 1;
    }
  };

  let exitCode = 1;
  try {
    exitCode = await steps();
  } catch (error) {
    say(`${isCodedError(error) ? `${error.code}: ${inertLine(error.message)}` : 'An unexpected error stopped the launch.'} Nothing was started.`);
  }
  say();
  await ask(deps.closePrompt).catch(() => '');
  return exitCode;
}

function printPreflight(say: (line?: string) => void, report: PreflightReport): void {
  for (const check of report.checks) {
    say(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${inertLine(check.detail)}${check.ok || !check.code ? '' : ` (${check.code})`}`);
  }
  say(`ready to run: ${report.ready}`);
  say();
}
