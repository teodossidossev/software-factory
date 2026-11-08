// The factory's own secrets in the state directory (SF-142, from src/dashboard.ts and
// src/server.ts): the dashboard token's and the MCP token's (SF-099) files, how a token file is
// read, and both tokens at once for the Redactor of a reviewer's run (SF-125).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';

export const DASHBOARD_TOKEN_FILE = 'dashboard-token';
// The MCP token (SF-099): the secret every request to the endpoint carries, kept in the state
// directory (mode 0600) across starts, in the dashboard token's format; a value of its own.
export const MCP_TOKEN_FILE = 'mcp-token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// A token file of the state directory: its token, or undefined when the file is missing; invalid
// (the error never holds the file's content) when it does not hold one token.
export async function readTokenFile(stateDir: string, file: string, invalid: () => FactoryError): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(stateDir, file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw invalid();
  }
  return token;
}

// The dashboard token and the MCP token of the state directory, in that order; a token file that
// is missing, unreadable or holds no token adds none.
export async function factoryTokens(paths: { stateDir: string }): Promise<string[]> {
  const tokens: string[] = [];
  for (const file of [DASHBOARD_TOKEN_FILE, MCP_TOKEN_FILE]) {
    const token = await readTokenFile(paths.stateDir, file, () => new FactoryError('invalid_token', `${file} does not hold a token.`)).catch(() => undefined);
    if (token !== undefined) {
      tokens.push(token);
    }
  }
  return tokens;
}
