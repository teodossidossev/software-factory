// npm run build: compiles the package into dist.next/ and only swaps it in for dist/ when every
// tsc passed, so a failed build leaves the working dist/ in place and bin/sf keeps a program to
// run. The new dist/ holds only the current sources' output: no compiled test of a deleted source
// stays.
//
// 1. Recovery: when dist/ is missing and dist.prev/ exists (a build killed between the two
//    renames of the swap), dist.prev/ goes back to dist/; a leftover dist.prev/ is removed only
//    when dist/ exists. A leftover dist.next/ is removed.
// 2. tsc -p tsconfig.json --outDir dist.next, then tsc -p tsconfig.web.json --outDir
//    dist.next/web. On a failure dist.next/ is removed and the build exits with tsc's status;
//    dist/ is not touched.
// 3. Swap: dist/ (when it exists) to dist.prev/, dist.next/ to dist/, then dist.prev/ is removed.
//    When the second rename fails, dist.prev/ goes back to dist/ before the build exits 1.
//
// --root <dir> is the package directory (default: this script's package); --tsc <path> the tsc
// script run with this Node (default: the package's node_modules/typescript/bin/tsc). A usage
// error exits 2.
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

const USAGE = 'usage: build [--root <dir>] [--tsc <path>]';

class UsageError extends Error {}

function parseArgs(args) {
  const options = { root: PACKAGE, tsc: join(PACKAGE, 'node_modules', 'typescript', 'bin', 'tsc') };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name !== '--root' && name !== '--tsc') {
      throw new UsageError(`build: unknown argument ${name}; ${USAGE}`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new UsageError(`build: ${name} needs a value; ${USAGE}`);
    }
    options[name.slice(2)] = resolve(value);
    index += 1;
  }
  return options;
}

function remove(path) {
  rmSync(path, { recursive: true, force: true });
}

function recover(dist, prev) {
  if (!existsSync(dist) && existsSync(prev)) {
    renameSync(prev, dist);
  } else if (existsSync(dist)) {
    remove(prev);
  }
}

// Runs one tsc; returns its exit code, or 1 when it could not start or a signal ended it.
function compile(root, tsc, project, outDir) {
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, project), '--outDir', outDir], { cwd: root, stdio: 'inherit' });
  if (result.error !== undefined) {
    console.error(`build: could not run ${tsc}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function swap(dist, next, prev) {
  const hadDist = existsSync(dist);
  if (hadDist) {
    renameSync(dist, prev);
  }
  try {
    renameSync(next, dist);
  } catch (error) {
    if (hadDist) {
      renameSync(prev, dist);
    }
    throw error;
  }
  remove(prev);
}

function main(args) {
  const { root, tsc } = parseArgs(args);
  const dist = join(root, 'dist');
  const next = join(root, 'dist.next');
  const prev = join(root, 'dist.prev');
  recover(dist, prev);
  remove(next);
  for (const [project, outDir] of [['tsconfig.json', next], ['tsconfig.web.json', join(next, 'web')]]) {
    const code = compile(root, tsc, project, outDir);
    if (code !== 0) {
      remove(next);
      return code;
    }
  }
  swap(dist, next, prev);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
