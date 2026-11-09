// The gate wrapper's socket filter (SF-161, src/seccomp.ts): the classic BPF program for x86_64 and
// aarch64 (the architecture check, the x32 bit, socket with AF_UNIX refused, everything else
// allowed), run over sample inputs by a small interpreter; spawnSeccomped writes it to fd 3 and
// closes it; and, with the real bubblewrap, under the gate's wrapper a Unix socket is refused while
// a child with piped stdio and a TCP connection to loopback still work.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type PathDenials, gateWrapper } from '../src/sandbox-denials.js';
import {
  AF_UNIX, BPF_JMP_JEQ_K, BPF_JMP_JSET_K, BPF_LD_W_ABS, BPF_RET_K, type BpfInstruction, FILTER_ARCHES, filterInstructions, filterProgram, filterSupports,
  SECCOMP_DATA_ARCH, SECCOMP_DATA_ARG0, SECCOMP_DATA_NR, SECCOMP_RET_ALLOW, SECCOMP_RET_EPERM, spawnSeccomped, X32_SYSCALL_BIT,
} from '../src/seccomp.js';
import { BWRAP_CANNOT_START, bubblewrapStarts } from './support/harness.js';

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_I386 = 0x40000003;

// One syscall as struct seccomp_data shows it to the filter (args[0] only).
interface Syscall {
  arch: number;
  nr: number;
  arg0?: number;
}

// A classic BPF interpreter for the instructions the filter may use: loads of a 32-bit word of
// seccomp_data, JEQ and JSET against a constant, RET of a constant. Any other instruction, a jump
// out of the program or a load outside the fields fails the test.
function run(program: readonly BpfInstruction[], syscall: Syscall): number {
  const data = (offset: number): number => {
    if (offset === SECCOMP_DATA_NR) {
      return syscall.nr >>> 0;
    }
    if (offset === SECCOMP_DATA_ARCH) {
      return syscall.arch >>> 0;
    }
    if (offset === SECCOMP_DATA_ARG0) {
      return (syscall.arg0 ?? 0) >>> 0;
    }
    throw new Error(`load at ${offset}`);
  };
  let accumulator = 0;
  for (let pc = 0; pc < program.length;) {
    const { code, jt, jf, k } = program[pc]!;
    if (code === BPF_LD_W_ABS) {
      accumulator = data(k);
      pc += 1;
    } else if (code === BPF_JMP_JEQ_K) {
      pc += 1 + (accumulator === k >>> 0 ? jt : jf);
    } else if (code === BPF_JMP_JSET_K) {
      pc += 1 + ((accumulator & k) !== 0 ? jt : jf);
    } else if (code === BPF_RET_K) {
      return k >>> 0;
    } else {
      throw new Error(`instruction ${code}`);
    }
  }
  throw new Error('ran off the end of the program');
}

test('the filter supports x64 and arm64 only, with the AUDIT_ARCH values and socket numbers of their syscall tables', () => {
  assert.deepEqual(FILTER_ARCHES, {
    x64: { auditArch: AUDIT_ARCH_X86_64, socket: 41, x32: true },
    arm64: { auditArch: AUDIT_ARCH_AARCH64, socket: 198, x32: false },
  });
  assert.ok(filterSupports('x64') && filterSupports('arm64'));
  for (const arch of ['ia32', 'arm', 'riscv64', 'ppc64', 's390x', 'toString']) {
    assert.equal(filterSupports(arch), false, arch);
    assert.throws(() => filterInstructions(arch), /the gate's socket filter does not support/);
  }
  assert.equal(SECCOMP_RET_EPERM, 0x00050001);
  assert.equal(SECCOMP_RET_ALLOW, 0x7fff0000);
  assert.deepEqual([SECCOMP_DATA_NR, SECCOMP_DATA_ARCH, SECCOMP_DATA_ARG0], [0, 4, 16]);
});

test('the x86_64 program: the architecture, the x32 bit, socket(AF_UNIX) refused; the rest allowed', () => {
  assert.deepEqual(filterInstructions('x64'), [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 4 },
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: AUDIT_ARCH_X86_64 },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_EPERM },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 },
    { code: BPF_JMP_JSET_K, jt: 3, jf: 0, k: X32_SYSCALL_BIT },
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 3, k: 41 },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 16 },
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: AF_UNIX },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_EPERM },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
  ]);
});

test('the aarch64 program: the architecture, socket(AF_UNIX) refused; the rest allowed; no x32 check', () => {
  assert.deepEqual(filterInstructions('arm64'), [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 4 },
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: AUDIT_ARCH_AARCH64 },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_EPERM },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 },
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 3, k: 198 },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 16 },
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: AF_UNIX },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_EPERM },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
  ]);
});

test('the programs over sample syscalls: AF_UNIX sockets, i386, x32 and the other architecture refused; AF_INET, AF_INET6, AF_NETLINK, socketpair, connect and the rest allowed', () => {
  const EPERM = SECCOMP_RET_EPERM;
  const ALLOW = SECCOMP_RET_ALLOW;
  const x64 = filterInstructions('x64');
  const cases: Array<[Syscall, number, string]> = [
    [{ arch: AUDIT_ARCH_X86_64, nr: 41, arg0: AF_UNIX }, EPERM, 'socket(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 41, arg0: 2 }, ALLOW, 'socket(AF_INET)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 41, arg0: 10 }, ALLOW, 'socket(AF_INET6)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 41, arg0: 16 }, ALLOW, 'socket(AF_NETLINK)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 53, arg0: AF_UNIX }, ALLOW, 'socketpair(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 42, arg0: 3 }, ALLOW, 'connect'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 0, arg0: AF_UNIX }, ALLOW, 'read'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 59 }, ALLOW, 'execve'],
    [{ arch: AUDIT_ARCH_X86_64, nr: X32_SYSCALL_BIT | 41, arg0: AF_UNIX }, EPERM, 'x32 socket(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: X32_SYSCALL_BIT | 41, arg0: 2 }, EPERM, 'x32 socket(AF_INET)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: X32_SYSCALL_BIT }, EPERM, 'x32 read'],
    [{ arch: AUDIT_ARCH_I386, nr: 359, arg0: AF_UNIX }, EPERM, 'i386 socket(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_I386, nr: 102, arg0: 1 }, EPERM, 'i386 socketcall(SYS_SOCKET)'],
    [{ arch: AUDIT_ARCH_I386, nr: 3 }, EPERM, 'i386 read'],
    [{ arch: AUDIT_ARCH_AARCH64, nr: 41, arg0: 2 }, EPERM, 'aarch64 on x86_64'],
  ];
  for (const [syscall, expected, name] of cases) {
    assert.equal(run(x64, syscall), expected >>> 0, `x86_64 ${name}`);
  }
  const arm64 = filterInstructions('arm64');
  const armCases: Array<[Syscall, number, string]> = [
    [{ arch: AUDIT_ARCH_AARCH64, nr: 198, arg0: AF_UNIX }, EPERM, 'socket(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_AARCH64, nr: 198, arg0: 2 }, ALLOW, 'socket(AF_INET)'],
    [{ arch: AUDIT_ARCH_AARCH64, nr: 198, arg0: 10 }, ALLOW, 'socket(AF_INET6)'],
    [{ arch: AUDIT_ARCH_AARCH64, nr: 199, arg0: AF_UNIX }, ALLOW, 'socketpair(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_AARCH64, nr: 203, arg0: 3 }, ALLOW, 'connect'],
    [{ arch: AUDIT_ARCH_AARCH64, nr: 41, arg0: AF_UNIX }, ALLOW, 'syscall 41 (not socket on aarch64)'],
    [{ arch: 0x40000028, nr: 281, arg0: AF_UNIX }, EPERM, 'arm (32-bit) socket(AF_UNIX)'],
    [{ arch: AUDIT_ARCH_X86_64, nr: 41, arg0: 2 }, EPERM, 'x86_64 on aarch64'],
  ];
  for (const [syscall, expected, name] of armCases) {
    assert.equal(run(arm64, syscall), expected >>> 0, `aarch64 ${name}`);
  }
});

test('filterProgram: struct sock_filter, 8 little-endian bytes per instruction', () => {
  for (const arch of ['x64', 'arm64']) {
    const instructions = filterInstructions(arch);
    const bytes = filterProgram(arch);
    assert.equal(bytes.length, instructions.length * 8);
    instructions.forEach((instruction, index) => {
      assert.deepEqual({
        code: bytes.readUInt16LE(index * 8), jt: bytes.readUInt8(index * 8 + 2), jf: bytes.readUInt8(index * 8 + 3), k: bytes.readUInt32LE(index * 8 + 4),
      }, { ...instruction, k: instruction.k >>> 0 });
    });
  }
});

let temp: string;

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-seccomp-')));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

// The child's exit, stdout and stderr.
async function ended(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

test('spawnSeccomped: bwrap gets the wrapper, "--" and the command, and reads the program from fd 3 to its end (the pipe is closed); fds 0 to 2 as given', { skip: process.platform !== 'linux' }, async () => {
  const bwrap = join(temp, 'fake-bwrap');
  const args = join(temp, 'fake-bwrap.args');
  const program = join(temp, 'fake-bwrap.program');
  await writeFile(bwrap, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\ncat <&3 > '${program}'\nexec 3<&-\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  await chmod(bwrap, 0o755);
  const child = spawnSeccomped(bwrap, ['--seccomp', '3', '--die-with-parent'], ['sh', '-c', 'cat; echo done >&2'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin!.end('the input');
  const result = await ended(child);
  assert.deepEqual(result, { code: 0, stdout: 'the input', stderr: 'done\n' });
  assert.deepEqual((await readFile(args, 'utf8')).trimEnd().split('\n'), ['--seccomp', '3', '--die-with-parent', '--', 'sh', '-c', 'cat; echo done >&2']);
  assert.deepEqual(await readFile(program), filterProgram());
});

// The real bubblewrap under the gate's wrapper, the filter loaded by spawnSeccomped.
const realBwrap = (): string | false => (process.platform !== 'linux' ? 'not Linux' : bubblewrapStarts() ? false : BWRAP_CANNOT_START);

const listening = async (server: Server, where: string | number): Promise<void> => {
  server.listen(where);
  await once(server, 'listening');
};

test('under the real bwrap with the gate\'s wrapper: node cannot connect to an abstract Unix socket (EPERM); it can still spawn a child with piped stdio and open a TCP connection to loopback', { skip: realBwrap() }, async () => {
  const empty: PathDenials = { tools: [], sandbox: { denyRead: [], denyWrite: [] }, claudeTmp: { denyRead: [], allowRead: [], allowWrite: [] }, kept: [], hooks: undefined };
  const wrapper = gateWrapper(empty, { worktree: temp, codexPath: process.execPath, codexHome: temp, iterationDir: temp, images: [], tmp: tmpdir() });
  assert.ok(wrapper.join(' ').includes('--seccomp 3'));
  const name = `sf-seccomp-test-${process.pid}`;
  // The probes exit as soon as they connect, so the server's side of a connection may see a reset:
  // it is closed at once, and its errors are no failure of the test.
  const hangUp = (socket: Socket): void => {
    socket.on('error', () => {});
    socket.destroy();
  };
  const unix = createServer(hangUp);
  const tcp = createServer(hangUp);
  await listening(unix, `\0${name}`);
  await listening(tcp, 0);
  const port = (tcp.address() as { port: number }).port;
  try {
    const node = (script: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      ended(spawnSeccomped('bwrap', wrapper, [process.execPath, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const connectTo = (target: string): string => `const c = require('node:net').connect(${target});
c.once('connect', () => { console.log('connected'); process.exit(0); });
c.once('error', (e) => { console.log(e.code); process.exit(1); });`;
    // Outside the wrapper the abstract socket connects: the refusal inside is the filter's.
    const outside = await ended(spawn(process.execPath, ['-e', connectTo(JSON.stringify(`\0${name}`))], { stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(outside, { code: 0, stdout: 'connected\n', stderr: '' });
    const refused = await node(connectTo(JSON.stringify(`\0${name}`)));
    assert.deepEqual(refused, { code: 1, stdout: 'EPERM\n', stderr: '' });
    const child = await node(`const r = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' });
console.log(r.status, String(r.stdout));`);
    assert.deepEqual(child, { code: 0, stdout: '0 piped\n', stderr: '' });
    const loopback = await node(connectTo(`${port}, '127.0.0.1'`));
    assert.deepEqual(loopback, { code: 0, stdout: 'connected\n', stderr: '' });
  } finally {
    unix.close();
    tcp.close();
  }
});
