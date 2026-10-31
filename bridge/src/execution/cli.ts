// Operator CLI of the SF-006 execution adapter. One-shot; nothing runs in the
// background. Takes exactly one command plus <app-id> <job-id>; no paths,
// flags or commands come from anywhere else.
//
//   scripts/sf006-execute.sh preflight <app-id> <job-id>   read-only readiness report
//   scripts/sf006-execute.sh prepare   <app-id> <job-id>   verify acceptance, copy the instruction (asks first)
//   scripts/sf006-execute.sh run       <app-id> <job-id>   start the one Claude Code session in this terminal (asks first)
//   scripts/sf006-execute.sh handoff   <app-id> <job-id>   instead of run: print the command to start by hand (asks first)
//   scripts/sf006-execute.sh collect   <app-id> <job-id>   bring results back after a manual or interrupted session (asks first)
//   scripts/sf006-execute.sh status    <app-id> <job-id>   read-only execution state
//   scripts/sf006-execute.sh audit-legacy                  read-only: records whose execution.json still
//                                                          carries the pre-Review 02 ignored-file baseline (counts only);
//                                                          exit 1 also when coverage is incomplete
//
// Exit code 0 when the command did what it says (for run/collect: state completed),
// 1 otherwise, 2 for usage errors.
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { FactoryJobError } from '../factory-jobs.js';
import { AppConfigError } from './app-config.js';
import { ExecutionError } from './errors.js';
import { auditLegacyRecords, formatLegacyAudit, type LegacyAudit } from './legacy-audit.js';
import { resolveRepoRoot } from '../repo-files.js';
import { claudeInstallation, localExecutionService } from './local-service.js';
import { instructionDestination, type ExecutionView, type PreflightReport } from './service.js';

const COMMANDS = ['preflight', 'prepare', 'run', 'handoff', 'collect', 'status'] as const;
type Command = (typeof COMMANDS)[number];
// Compiled to bridge/dist/src/execution/cli.js; the mediator is the checkout that contains it.
const MEDIATOR_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function confirm(question: string): Promise<boolean> {
  if (!interactive()) {
    return false;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

function printView(result: ExecutionView): void {
  console.log(`${result.app_id}/${result.job_id}: ${result.state}`);
  console.log(`  instruction in the app repository: ${result.destination}`);
  if (result.session_id) console.log(`  Claude session id: ${result.session_id}`);
  if (result.error) console.log(`  ${result.error.code}: ${result.error.message}`);
  if (result.recovery) console.log(`  next: ${result.recovery}`);
}

function printPreflight(report: PreflightReport): void {
  for (const check of report.checks) {
    console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}${check.ok || !check.code ? '' : ` (${check.code})`}`);
  }
  console.log(`state: ${report.state}; ready to run: ${report.ready}`);
}

// Exit code 1 when any ChatGPT-readable record may still name ignored entries or credential
// files, or when any record or directory could not be inspected (coverage incomplete).
function printLegacyAudit(audit: LegacyAudit): number {
  const { lines, exitCode } = formatLegacyAudit(audit);
  lines.forEach((line) => console.log(line));
  return exitCode;
}

async function main(argv: string[]): Promise<number> {
  const [command, appId, jobId, ...extra] = argv;
  if (command === 'audit-legacy') {
    if (appId !== undefined) {
      console.error('usage: sf006-execute audit-legacy');
      return 2;
    }
    return printLegacyAudit(await auditLegacyRecords(await resolveRepoRoot(MEDIATOR_ROOT)));
  }
  if (!COMMANDS.includes(command as Command) || appId === undefined || jobId === undefined || extra.length > 0) {
    console.error(`usage: sf006-execute <${COMMANDS.join('|')}> <app-id> <job-id> | audit-legacy`);
    return 2;
  }
  const claude = await claudeInstallation();
  const service = localExecutionService(await resolveRepoRoot(MEDIATOR_ROOT), claude);
  const label = `${appId}/${jobId}`;

  switch (command as Command) {
    case 'preflight': {
      const report = await service.preflight(appId, jobId);
      printPreflight(report);
      return report.ready ? 0 : 1;
    }
    case 'status': {
      const status = await service.status(appId, jobId);
      printView(status);
      if (status.process_alive !== null) console.log(`  session process alive: ${status.process_alive}`);
      console.log(`  history: ${status.history.map((entry) => `${entry.state}@${entry.at}`).join(' -> ')}`);
      return 0;
    }
    case 'prepare': {
      if (!(await confirm(`Verify the OpenClaw acceptance of ${label} and copy its instruction to ${instructionDestination(jobId)} in the app repository?`))) {
        console.error('Not confirmed (an interactive terminal is required); nothing changed.');
        return 1;
      }
      const result = await service.prepare(appId, jobId);
      printView(result);
      return result.state === 'prepared' ? 0 : 1;
    }
    case 'run': {
      if (!interactive()) {
        console.error('run needs an interactive terminal: Claude Code asks you for every permission in it. Use handoff otherwise.');
        return 1;
      }
      const report = await service.preflight(appId, jobId);
      printPreflight(report);
      if (!report.ready) {
        console.error('Not ready; nothing was started.');
        return 1;
      }
      if (!(await confirm(`Start ONE Claude Code session for ${label} in the app repository with /implement ${instructionDestination(jobId)}? This can change files there.`))) {
        console.error('Not confirmed; nothing was started.');
        return 1;
      }
      // Ctrl+C belongs to Claude Code while it runs; the adapter waits for its exit.
      const ignore = () => undefined;
      process.on('SIGINT', ignore);
      process.on('SIGQUIT', ignore);
      try {
        const result = await service.run(appId, jobId, () =>
          confirm(`Claude Code has exited. Did /implement finish its work for ${label} in that session?`),
        );
        printView(result);
        return result.state === 'completed' ? 0 : 1;
      } finally {
        process.off('SIGINT', ignore);
        process.off('SIGQUIT', ignore);
      }
    }
    case 'handoff': {
      if (!interactive()) {
        console.error('handoff prints a host path; it needs an interactive terminal.');
        return 1;
      }
      if (!(await confirm(`Hand ${label} to you for a manual Claude Code session (the adapter will not start it)?`))) {
        console.error('Not confirmed; nothing changed.');
        return 1;
      }
      const result = await service.handoff(appId, jobId);
      printView(result);
      // The session gate (flock) wraps the command: it refuses at once while another session runs.
      const quoted = result.gated_command.map((part) => (/^[A-Za-z0-9_./:@=-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(' ');
      console.log('\nRun this yourself, answer the permission prompts, end the session, then run collect.');
      console.log('It refuses to start (exit 75) while another Claude session holds the session gate:\n');
      console.log(`  cd '${result.cwd.replaceAll("'", "'\\''")}'`);
      console.log(`  ${quoted}\n`);
      return 0;
    }
    case 'collect': {
      const finished = await confirm(`Has /implement finished for ${label} and has its Claude Code session ended?`);
      const result = await service.collect(appId, jobId, { sessionFinished: finished });
      printView(result);
      return result.state === 'completed' ? 0 : 1;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Coded adapter errors carry no host paths; anything else is reported by name and code only.
    const coded = error instanceof ExecutionError || error instanceof AppConfigError || error instanceof FactoryJobError;
    const code = (error as { code?: unknown }).code;
    console.error(`sf006-execute: ${coded ? `${String(code)}: ${(error as Error).message}` : `unexpected ${(error as Error).name ?? 'error'}${code ? ` (${String(code)})` : ''}`}`);
    process.exitCode = 1;
  },
);
