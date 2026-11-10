// The Implementer's question before any change: at the MR step, a reviewed change with no path
// to commit and a Report that asks something stop the job as the user's decision
// (implementer_question), not as missing MR text the Implementer had no reason to write.
import { reportSections } from './explain.js';
import type { Job, JobStore } from './jobs.js';
import { commitPaths } from './mr.js';

export const IMPLEMENTER_QUESTION = 'implementer_question';
// The longest the questions run in the stop's message; a longer text is cut and ends in "…".
export const MAX_QUESTION_CHARS = 400;

// The open questions of a Report, whitespace collapsed; undefined when the section is missing,
// empty or "None." (case and a trailing dot ignored).
export function openQuestions(report: string | undefined): string | undefined {
  const questions = reportSections(report).open_questions.replace(/\s+/g, ' ').trim();
  return questions === '' || /^none\.?$/i.test(questions) ? undefined : questions;
}

// The stop's message, the questions cut to MAX_QUESTION_CHARS, the last one "…", without splitting
// a surrogate pair.
export function questionMessage(questions: string): string {
  if (questions.length <= MAX_QUESTION_CHARS) {
    return `The Implementer changed nothing and asks: ${questions}`;
  }
  let end = MAX_QUESTION_CHARS - 1;
  const code = questions.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `The Implementer changed nothing and asks: ${questions.slice(0, end)}…`;
}

// The stop when the Report of the job's iteration asks something and the reviewed change in cwd
// has nothing to commit against the job's base commit; undefined otherwise (also without a Report
// or a base commit), and the MR step goes on.
export async function implementerQuestion(jobs: JobStore, job: Job, cwd: string): Promise<{ code: typeof IMPLEMENTER_QUESTION; message: string } | undefined> {
  if (job.base_commit === null) {
    return undefined;
  }
  const report = await jobs.readIteration(job.workspace, job.ticket, job.iteration).then(({ report: text }) => text, () => undefined);
  const questions = openQuestions(report);
  if (questions === undefined || (await commitPaths(cwd, job.base_commit)).length > 0) {
    return undefined;
  }
  return { code: IMPLEMENTER_QUESTION, message: questionMessage(questions) };
}
