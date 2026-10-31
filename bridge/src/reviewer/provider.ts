// SF-010: the narrow boundary between the review coordinator and whatever reviews.
//
// A ReviewProvider gets the verified review input (input.ts) as data and returns an untrusted value
// that the coordinator validates (validateResponse). It has no access to the job directory, the
// session, the supervisor, Git or the bridge: it cannot deliver, accept, authorize or launch
// anything. A future real reviewer (a model API, or an OpenClaw agent behind the existing channel)
// implements the same interface; none is implemented or registered here.
//
// The only implementation is OfflineReviewProvider: deterministic, in-process, for tests and
// demonstrations. It reviews nothing in any real sense and makes no network call.
import { MAX_FINDING_CHARS } from '../executor/records.js';
import type { ReviewInput } from './input.js';
import { MAX_PROVIDER_FINDINGS, providerResponseSchema, type ProviderFinding, type ProviderResponse } from './records.js';

export interface ReviewProvider {
  // The id a delegation and the provider opt-in must both name.
  readonly id: string;
  // One attempt. The signal aborts at the attempt timeout; the result is untrusted until validated.
  review(input: ReviewInput, signal: AbortSignal): Promise<unknown>;
}

// A validated response, or the code it was refused with (it then costs an attempt like an error).
export function validateResponse(raw: unknown, input: ReviewInput): { ok: true; response: ProviderResponse } | { ok: false; code: string } {
  const parsed = providerResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'provider_output_invalid' };
  }
  if (parsed.data.outcome === 'findings') {
    const paths = new Set(input.reviewable_paths);
    for (const finding of parsed.data.findings) {
      if (finding.file !== null && !paths.has(finding.file)) {
        return { ok: false, code: 'finding_file_not_reviewed' };
      }
      if (finding.file === null && finding.line !== null) {
        return { ok: false, code: 'finding_line_without_file' };
      }
    }
  }
  return { ok: true, response: parsed.data };
}

// The text of one finding as the supervisor delivers it (a numbered line of review data).
export function findingText(finding: ProviderFinding): string {
  const where = finding.file === null ? 'general' : finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return `[${finding.severity}] ${where}: ${finding.text}`.slice(0, MAX_FINDING_CHARS);
}

// A rule of the offline provider: a pure function of the input. Tests pass their own rules.
export type OfflineRule = (input: ReviewInput) => unknown;

// The default rule: every line the diff adds that contains "SF010-FINDING:" becomes a finding on
// that file (the text after the marker, as data); no such line is a clean verdict.
export const markerRule: OfflineRule = (input) => {
  const findings: ProviderFinding[] = [];
  let file: string | null = null;
  let line = 0;
  // File headers (---/+++) occur only between `diff --git` and the first hunk; inside a hunk a line
  // starting with "+++" is an added line whose content starts with "++".
  let inHunk = false;
  for (const text of input.diff.text.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
      continue;
    }
    if (!inHunk && text.startsWith('+++ ')) {
      file = text.slice(4).replace(/^[ab]\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (text.startsWith('+')) {
      const marker = text.indexOf('SF010-FINDING:');
      if (marker >= 0 && file !== null && file !== '/dev/null') {
        findings.push({ file, line, severity: 'major', text: text.slice(marker + 'SF010-FINDING:'.length).trim().slice(0, 500) || 'marked finding' });
      }
      line += 1;
    } else if (text.startsWith(' ')) {
      line += 1;
    }
  }
  if (findings.length === 0) {
    return { outcome: 'clean', summary: `Offline review of ${input.iteration_id}: no marked findings.` };
  }
  return { outcome: 'findings', summary: `Offline review of ${input.iteration_id}: ${findings.length} marked finding(s).`, findings: findings.slice(0, MAX_PROVIDER_FINDINGS) };
};

export class OfflineReviewProvider implements ReviewProvider {
  readonly id: string;
  readonly #rule: OfflineRule;
  // Every call, for the tests: how often the provider ran and on which input.
  readonly calls: Array<{ job_id: string; iteration_id: string; input_sha256: string }> = [];

  constructor(rule: OfflineRule = markerRule, id = 'offline-fixture') {
    this.id = id;
    this.#rule = rule;
  }

  async review(input: ReviewInput, signal: AbortSignal): Promise<unknown> {
    this.calls.push({ job_id: input.job_id, iteration_id: input.iteration_id, input_sha256: input.input_sha256 });
    if (signal.aborted) {
      throw new Error('aborted');
    }
    return this.#rule(input);
  }
}
