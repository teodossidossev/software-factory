// Runs a command on a real pseudo-terminal (Python pty) and types scripted
// operator answers, strictly in order: each answer is typed when its prompt
// appears after the previous answer. Returns what the terminal showed. Used for
// the operator console and attend, which refuse to run without a TTY.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DRIVER = String.raw`
import json, os, pty, select, signal, sys, time
spec = json.load(open(sys.argv[1]))
pid, fd = pty.fork()
if pid == 0:
    os.execve(spec['argv'][0], spec['argv'], spec['env'])
with open(spec['pidfile'], 'w') as f:
    f.write(str(pid))
out = b''
pos = 0
answers = list(spec['answers'])
deadline = time.time() + spec['timeout']
while True:
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        out += b'\n[pty: timeout]\n'
        break
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
    while answers:
        index = out.find(answers[0][0].encode(), pos)
        if index >= 0:
            pos = index + len(answers[0][0])
            time.sleep(0.05)
            os.write(fd, answers[0][1].encode())
            answers.pop(0)
            break
        # An optional prompt is skipped once the next prompt has appeared without it.
        if len(answers[0]) > 2 and answers[0][2] and len(answers) > 1 and out.find(answers[1][0].encode(), pos) >= 0:
            answers.pop(0)
            continue
        break
_, status = os.waitpid(pid, 0)
with open(spec['out'], 'w') as f:
    json.dump({'exit': os.waitstatus_to_exitcode(status), 'output': out.decode('utf8', 'replace'), 'unanswered': [a[0] for a in answers]}, f)
`;

export interface PtyResult {
  exit: number;
  output: string;
  unanswered: string[];
}

export interface PtyRun {
  // Resolves when the command has ended.
  done: Promise<PtyResult>;
  // The pid of the command on the terminal (once started).
  pid(): Promise<number>;
}

// [prompt text to wait for, keys to type, optional]; "\r" is Enter. An optional answer is
// skipped when the next prompt appears without its prompt.
export type Answer = [string, string] | [string, string, boolean];

export function runInPty(workDir: string, argv: string[], answers: Answer[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): PtyRun {
  const id = randomUUID();
  const spec = {
    argv,
    env: options.env ?? process.env,
    answers,
    timeout: options.timeout ?? 60,
    out: join(workDir, `pty-${id}.json`),
    pidfile: join(workDir, `pty-${id}.pid`),
  };
  const done = (async () => {
    await writeFile(join(workDir, 'pty-driver.py'), DRIVER);
    await writeFile(join(workDir, `pty-${id}.spec.json`), JSON.stringify(spec));
    await new Promise<void>((resolve, reject) => {
      const child = spawn('python3', ['-I', join(workDir, 'pty-driver.py'), join(workDir, `pty-${id}.spec.json`)], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    return JSON.parse(await readFile(spec.out, 'utf8')) as PtyResult;
  })();
  return {
    done,
    async pid() {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const text = await readFile(spec.pidfile, 'utf8').catch(() => '');
        if (text !== '') return Number(text);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the pty command did not start');
    },
  };
}

// Live processes of this host whose program is marker (e.g. the fake claude's path): argv[0], or
// argv[1] for a script run by its interpreter. A wrapper (flock) that merely names it does not count.
export async function liveProcesses(marker: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0');
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      // Zombies have ended.
      if ((argv[0] === marker || argv[1] === marker) && stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z') pids.push(Number(entry));
    } catch {
      // Ended meanwhile.
    }
  }
  return pids;
}
