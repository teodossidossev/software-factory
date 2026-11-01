// Execution configuration, read once when `sf serve` starts.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { FactoryError } from './errors.js';

export interface Config {
  stateDir: string;
  checkAfterStartMin: number;
  checkAfterFixMin: number;
  maxTurns: number;
  maxIterations: number;
  // Claude Code executable for the Implementer; undefined uses the SDK's bundled binary.
  claudePath: string | undefined;
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_STATE_DIR) {
    return env.SF_STATE_DIR;
  }
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'software-factory');
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100000) {
    throw new FactoryError('invalid_config', `${name} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const claudePath = env.SF_CLAUDE || undefined;
  if (claudePath !== undefined && !isAbsolute(claudePath)) {
    throw new FactoryError('invalid_config', 'SF_CLAUDE must be an absolute path.');
  }
  return {
    stateDir: stateDir(env),
    checkAfterStartMin: positiveInteger(env, 'SF_CHECK_AFTER_START_MIN', 15),
    checkAfterFixMin: positiveInteger(env, 'SF_CHECK_AFTER_FIX_MIN', 5),
    maxTurns: positiveInteger(env, 'SF_MAX_TURNS', 150),
    maxIterations: positiveInteger(env, 'SF_MAX_ITERATIONS', 5),
    claudePath,
  };
}
