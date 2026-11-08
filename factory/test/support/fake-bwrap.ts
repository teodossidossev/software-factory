// A fake bubblewrap for the tests (SF-125), run by the bwrap script the harness puts first on PATH
// (fakeBwrapBin): this checker runs first, then the script execs the command after "--", so a
// signal to bwrap reaches the command itself. It logs its argv to $HOME/fake-bwrap.log and emulates
// the denials of the mounts on the command's absolute-path arguments (the command included): the
// last mount on the path or on a folder above it decides; a --tmpfs or a --ro-bind of /dev/null
// hides it (the tmpfs's own folder too, where bwrap would show it empty), any other bind, --dev and
// --proc show it; a path no mount covers is hidden. A hidden argument fails the command as its
// ENOENT would: one line on stderr, exit 1. With $HOME/fake-bwrap.json {"open": true} nothing is
// hidden. An option the fake does not know exits 2.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

// The options of the gate's wrapper (src/sandbox-denials.ts) and of the test command's sandbox
// (bwrapArgs, src/test-command.ts). --unshare-net, --remount-ro and --chdir change no denial: the
// bwrap script runs the command from --chdir's folder.
const ARITY: Record<string, number> = {
  '--die-with-parent': 0, '--unshare-pid': 0, '--unshare-net': 0, '--unshare-user': 0, '--new-session': 0,
  '--tmpfs': 1, '--remount-ro': 1, '--chdir': 1, '--dev': 1, '--proc': 1, '--ro-bind': 2, '--bind': 2,
};

const argv = process.argv.slice(2);
const home = process.env.HOME ?? '.';
appendFileSync(join(home, 'fake-bwrap.log'), `${JSON.stringify({ argv })}\n`);
const control = join(home, 'fake-bwrap.json');
const open = existsSync(control) && (JSON.parse(readFileSync(control, 'utf8')) as { open?: boolean }).open === true;

const within = (path: string, dir: string): boolean => {
  const inside = relative(dir, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
};

const mounts: Array<{ target: string; shows: boolean }> = [];
let index = 0;
for (; index < argv.length && argv[index] !== '--'; index += 1) {
  const option = argv[index]!;
  const arity = ARITY[option];
  if (arity === undefined || index + arity >= argv.length) {
    process.stderr.write(`fake bwrap: unknown option or missing value: ${option}\n`);
    process.exit(2);
  }
  if (option === '--tmpfs') {
    mounts.push({ target: argv[index + 1]!, shows: false });
  } else if (option === '--dev' || option === '--proc') {
    mounts.push({ target: argv[index + 1]!, shows: true });
  } else if (arity === 2) {
    mounts.push({ target: argv[index + 2]!, shows: argv[index + 1] !== '/dev/null' });
  }
  index += arity;
}
const command = argv.slice(index + 1);
if (command.length === 0) {
  process.stderr.write('fake bwrap: no command after --\n');
  process.exit(2);
}
if (!open) {
  for (const path of command.filter((arg) => arg.startsWith('/'))) {
    const decides = mounts.filter((mount) => within(path, mount.target)).at(-1);
    if (decides?.shows !== true) {
      process.stderr.write(`${command[0]}: ${path}: No such file or directory\n`);
      process.exit(1);
    }
  }
}
