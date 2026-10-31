// Evidence from a Claude Code session transcript,
// <projects dir>/<cwd with non-alphanumerics as "-">/<session-id>.jsonl.
// The format is internal to Claude Code and changes between versions, so the
// evidence is strict and fails closed: anything missing or unrecognised means
// "not shown", never "shown". Accepted as an invocation only when:
//   - the first user message of the session (sidechains and meta entries aside)
//     is <command-name>/<skill></command-name><command-args>…</command-args>,
//   - it was recorded in the expected working directory,
//   - the next skill body loaded is the expected skill directory
//     ("Base directory for this skill: <dir>").
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_SLUG = 200;

export interface SessionEvidence {
  transcript_found: boolean;
  skill_invoked: boolean;
  args_match: boolean;
  cwd_match: boolean;
  commands: Array<{ command: string; ok: boolean }>;
  final_message: string | null;
}

export interface ExpectedSession {
  sessionId: string;
  cwd: string;
  skill: string;
  // The skill directory the session must load (the operator's installed skill).
  skillDir: string;
  args: string;
}

interface Entry {
  type?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown };
}

// The project directory name Claude Code derives from a working directory.
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

// Only the project directory Claude Code derives from the working directory is searched.
export async function findTranscript(projectsDir: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const slug = projectSlug(cwd);
  const candidates =
    slug.length <= MAX_SLUG
      ? [slug]
      : (await readdir(projectsDir).catch(() => [] as string[])).filter((name) => name.startsWith(slug.slice(0, MAX_SLUG)));
  for (const project of candidates) {
    const file = join(projectsDir, project, `${sessionId}.jsonl`);
    try {
      const stats = await stat(file);
      if (stats.isFile() && stats.size <= MAX_TRANSCRIPT_BYTES) {
        return file;
      }
    } catch {
      // Not there.
    }
  }
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part: { type?: string; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

async function sameDir(a: string, b: string): Promise<boolean> {
  if (a === b) {
    return true;
  }
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

export async function readSessionEvidence(projectsDir: string, expected: ExpectedSession): Promise<SessionEvidence> {
  const evidence: SessionEvidence = {
    transcript_found: false,
    skill_invoked: false,
    args_match: false,
    cwd_match: false,
    commands: [],
    final_message: null,
  };
  const file = await findTranscript(projectsDir, expected.cwd, expected.sessionId);
  if (file === undefined) {
    return evidence;
  }
  evidence.transcript_found = true;
  const results = new Map<string, boolean>();
  const calls: Array<{ id: string; command: string }> = [];
  // first: waiting for the first user message; body: invocation seen, waiting for the skill body; done.
  let phase: 'first' | 'body' | 'done' = 'first';
  let loadedDir: string | undefined;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.sessionId !== expected.sessionId || entry.isSidechain === true) {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const text = textOf(content);
      if (phase === 'first' && entry.isMeta !== true && text !== '') {
        const invocation = /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>\/([^<]+)<\/command-name>\s*<command-args>([^<]*)<\/command-args>\s*$/.exec(text);
        phase = invocation && invocation[1] === expected.skill ? 'body' : 'done';
        if (invocation) {
          evidence.args_match = invocation[2]!.trim() === expected.args;
          evidence.cwd_match = entry.cwd !== undefined && (await sameDir(entry.cwd, expected.cwd));
        }
      } else if (phase === 'body' && text.startsWith('Base directory for this skill: ')) {
        loadedDir = text.split('\n')[0]!.slice('Base directory for this skill: '.length).trim();
        phase = 'done';
      }
      if (Array.isArray(content)) {
        for (const part of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>) {
          if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
            results.set(part.tool_use_id, part.is_error !== true);
          }
        }
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; id?: string; name?: string; input?: { command?: unknown } }>) {
        if (part?.type === 'tool_use' && part.name === 'Bash' && typeof part.input?.command === 'string' && typeof part.id === 'string') {
          calls.push({ id: part.id, command: part.input.command });
        }
      }
      const text = textOf(content).trim();
      if (text !== '') {
        evidence.final_message = text;
      }
    }
  }
  evidence.skill_invoked = loadedDir !== undefined && (await sameDir(loadedDir, expected.skillDir));
  evidence.commands = calls.map((call) => ({ command: call.command, ok: results.get(call.id) ?? false }));
  return evidence;
}
