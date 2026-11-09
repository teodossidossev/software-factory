// The socket filter of the Codex gate's bubblewrap wrapper: a classic BPF seccomp program bwrap
// loads from fd 3 (--seccomp 3, gateWrapper in sandbox-denials.ts). The wrapper shares the host's
// network namespace, since Codex reaches OpenAI, so the abstract Unix sockets of the host (the X
// server's @/tmp/.X11-unix/X0) are reachable from inside it; the filter refuses socket(AF_UNIX, ...)
// with EPERM. socketpair (Node's child stdio), TCP and UDP stay allowed. A syscall of another
// architecture than the host's (i386 on x86_64) and an x32 syscall on x86_64 are refused, so no other
// syscall table reaches socket around the filter.
import { type ChildProcess, spawn, type SpawnOptions, type StdioOptions } from 'node:child_process';
import type { Writable } from 'node:stream';

// One instruction of a classic BPF program (struct sock_filter).
export interface BpfInstruction {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

// The instruction classes and modes the filter uses (linux/bpf_common.h).
export const BPF_LD_W_ABS = 0x20;
export const BPF_JMP_JEQ_K = 0x15;
export const BPF_JMP_JSET_K = 0x45;
export const BPF_RET_K = 0x06;

// The offsets in struct seccomp_data: nr (int), arch (u32), instruction_pointer (u64), args[6]
// (u64 each). The low 32 bits of args[0] are at 16 on a little-endian machine; socket's domain is
// an int, so the kernel reads those bits only.
export const SECCOMP_DATA_NR = 0;
export const SECCOMP_DATA_ARCH = 4;
export const SECCOMP_DATA_ARG0 = 16;

// The filter's answers (linux/seccomp.h): SECCOMP_RET_ERRNO with EPERM (1), SECCOMP_RET_ALLOW.
export const SECCOMP_RET_EPERM = 0x00050000 | 1;
export const SECCOMP_RET_ALLOW = 0x7fff0000;

export const AF_UNIX = 1;
// __X32_SYSCALL_BIT: an x32 syscall number on x86_64.
export const X32_SYSCALL_BIT = 0x40000000;

// Per Node architecture the filter supports: its AUDIT_ARCH value (linux/audit.h) and the number of
// socket in its syscall table.
export const FILTER_ARCHES: Readonly<Record<string, { auditArch: number; socket: number; x32: boolean }>> = {
  x64: { auditArch: 0xc000003e, socket: 41, x32: true },
  arm64: { auditArch: 0xc00000b7, socket: 198, x32: false },
};

// Whether the filter supports a Node architecture (process.arch).
export function filterSupports(arch: string): boolean {
  return Object.hasOwn(FILTER_ARCHES, arch);
}

// The filter's instructions for a supported architecture:
//   the architecture, other than the host's: EPERM;
//   on x86_64, a syscall number with the x32 bit: EPERM;
//   socket with AF_UNIX as its first argument: EPERM;
//   anything else: allowed.
export function filterInstructions(arch: string): BpfInstruction[] {
  const target = filterSupports(arch) ? FILTER_ARCHES[arch] : undefined;
  if (target === undefined) {
    throw new Error(`the gate's socket filter does not support ${arch}`);
  }
  const op = (code: number, k: number, jt = 0, jf = 0): BpfInstruction => ({ code, jt, jf, k });
  const deny = op(BPF_RET_K, SECCOMP_RET_EPERM);
  const allow = op(BPF_RET_K, SECCOMP_RET_ALLOW);
  // After the syscall number is loaded: [x32 check], socket?, load arg0, AF_UNIX?, deny, allow.
  const x32 = target.x32 ? [op(BPF_JMP_JSET_K, X32_SYSCALL_BIT, 3, 0)] : [];
  return [
    op(BPF_LD_W_ABS, SECCOMP_DATA_ARCH),
    op(BPF_JMP_JEQ_K, target.auditArch, 1, 0),
    deny,
    op(BPF_LD_W_ABS, SECCOMP_DATA_NR),
    ...x32,
    op(BPF_JMP_JEQ_K, target.socket, 0, 3),
    op(BPF_LD_W_ABS, SECCOMP_DATA_ARG0),
    op(BPF_JMP_JEQ_K, AF_UNIX, 0, 1),
    deny,
    allow,
  ];
}

// The program's bytes as bwrap reads them: struct sock_filter, 8 bytes each, little-endian (both
// supported architectures are).
export function filterProgram(arch: string = process.arch): Buffer {
  const instructions = filterInstructions(arch);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => {
    bytes.writeUInt16LE(instruction.code, index * 8);
    bytes.writeUInt8(instruction.jt, index * 8 + 2);
    bytes.writeUInt8(instruction.jf, index * 8 + 3);
    bytes.writeUInt32LE(instruction.k >>> 0, index * 8 + 4);
  });
  return bytes;
}

// Spawns bwrap with the wrapper (which holds --seccomp 3) and the command after "--", the filter
// program written to its fd 3 and that pipe closed, so bwrap reads to its end and goes on. The
// options' stdio give fds 0 to 2 (default pipes); fd 3 is always a pipe. A write error on fd 3 is
// ignored: bwrap's exit tells.
export function spawnSeccomped(bwrap: string, wrapper: string[], command: string[], options: SpawnOptions): ChildProcess {
  const program = filterProgram();
  const given: StdioOptions = options.stdio ?? 'pipe';
  const stdio = Array.isArray(given) ? [given[0] ?? 'pipe', given[1] ?? 'pipe', given[2] ?? 'pipe'] : [given, given, given];
  const child = spawn(bwrap, [...wrapper, '--', ...command], { ...options, stdio: [...stdio, 'pipe'] });
  const fd3 = child.stdio[3] as Writable | null | undefined;
  fd3?.on('error', () => {});
  fd3?.end(program);
  return child;
}
