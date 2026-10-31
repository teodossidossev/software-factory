// Contract tests for the repository file reader behind factory_read_file,
// run against a throwaway repository root with fixture content.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { RepoFiles, resolveRepoRoot } from '../src/repo-files.js';

// Expected byte counts and digests were computed independently (Python hashlib).
const FIXTURES = {
  source: {
    path: 'bridge/src/sample.ts',
    text: 'export const answer = 42;\n',
    bytes: 26,
    sha256: 'a2098bd92b10bf8b816d24b7556b1ce8c49a879d130489065ef1051c17e042f6',
  },
  untracked: {
    path: 'notes/untracked.md',
    text: '﻿Бележка: проба 🚀\r\nвтори ред\r\n',
    bytes: 55,
    sha256: '21ccc42f8ed5a6b36c9cab40566c537859b41ba04dcb8b72fc87dbfac7374377',
  },
  ignoredReview: {
    path: 'review/SF-002/MANIFEST.md',
    text: '# Manifest\nignored review artifact',
    bytes: 34,
    sha256: '13c7e48fb4291552163d4bfa7a177805a0eba298891f4e81d7b5a02cf84af5b0',
  },
  exampleConfig: {
    path: 'config/tunnel-client/software-factory.example.yaml',
    text: 'tunnel_id: "tunnel_REPLACE"\n',
    bytes: 28,
    sha256: 'de30e603eae20f0ff5bd827dd9628b028a2b985c82656980476040f076df32fb',
  },
};

let sandbox: string;
let root: string;
let files: RepoFiles;

async function put(relativePath: string, content: string | Buffer): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'sf-repo-files-'));
  root = join(sandbox, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await put('.gitignore', 'review/\n');
  for (const fixture of Object.values(FIXTURES)) {
    await put(fixture.path, fixture.text);
  }
  files = new RepoFiles(await resolveRepoRoot(root));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test('reads tracked-style, untracked, ignored review and example config files exactly', async () => {
  for (const fixture of Object.values(FIXTURES)) {
    assert.deepEqual(await files.read({ path: fixture.path }), {
      path: fixture.path,
      encoding: 'utf-8',
      bytes: fixture.bytes,
      sha256: fixture.sha256,
      offset: 0,
      returned_bytes: fixture.bytes,
      text: fixture.text,
      next_offset: null,
    });
  }
});

async function readAllPages(path: string, maxBytes?: number): Promise<{ text: Buffer; pages: number; hashes: Set<string> }> {
  const chunks: Buffer[] = [];
  const hashes = new Set<string>();
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const page = await files.read({ path, offset, ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }) });
    assert.equal(page.offset, offset);
    assert.ok(page.returned_bytes <= (maxBytes ?? 16384), `page of ${page.returned_bytes} bytes`);
    assert.equal(Buffer.byteLength(page.text, 'utf8'), page.returned_bytes);
    chunks.push(Buffer.from(page.text, 'utf8'));
    hashes.add(page.sha256);
    offset = page.next_offset;
    pages += 1;
  }
  return { text: Buffer.concat(chunks), pages, hashes };
}

test('pages split only on character boundaries and reassemble a long single line exactly', async () => {
  await put('docs/split.txt', 'a😀b');
  const first = await files.read({ path: 'docs/split.txt', max_bytes: 4 });
  assert.deepEqual([first.text, first.returned_bytes, first.next_offset], ['a', 1, 1]);
  const second = await files.read({ path: 'docs/split.txt', offset: 1, max_bytes: 4 });
  assert.deepEqual([second.text, second.returned_bytes, second.next_offset], ['😀', 4, 5]);
  const last = await files.read({ path: 'docs/split.txt', offset: 5, max_bytes: 4 });
  assert.deepEqual([last.text, last.returned_bytes, last.next_offset], ['b', 1, null]);

  // One ~100 KB line mixing 1-, 2- and 4-byte characters, no newline until the very end.
  const longLine = Buffer.from(`${'x'.repeat(3)}${'жабa🚀'.repeat(9000)}\n`, 'utf8');
  await put('docs/long-line.txt', longLine);
  // Small page sizes on a short mixed line exercise every boundary position cheaply.
  const mixed = Buffer.from('жабa🚀'.repeat(100), 'utf8');
  await put('docs/mixed.txt', mixed);
  const cases: Array<[string, Buffer, number | undefined]> = [
    ['docs/long-line.txt', longLine, undefined],
    ['docs/long-line.txt', longLine, 32768],
    ['docs/long-line.txt', longLine, 16383],
    ['docs/mixed.txt', mixed, 4],
    ['docs/mixed.txt', mixed, 5],
    ['docs/mixed.txt', mixed, 7],
  ];
  for (const [path, original, maxBytes] of cases) {
    const { text, pages, hashes } = await readAllPages(path, maxBytes);
    assert.ok(text.equals(original), `reassembled bytes differ for ${path} max_bytes=${maxBytes}`);
    assert.equal(hashes.size, 1);
    assert.ok(pages > 1);
  }
});

function rejectsWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String(error));
    assert.doesNotMatch(String((error as Error).message), new RegExp(sandbox.replaceAll('/', '\\/')));
    return true;
  };
}

test('handles empty files, EOF, invalid ranges, non-text content and the size limit', async () => {
  await put('docs/empty.txt', '');
  assert.deepEqual(await files.read({ path: 'docs/empty.txt' }), {
    path: 'docs/empty.txt',
    encoding: 'utf-8',
    bytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    offset: 0,
    returned_bytes: 0,
    text: '',
    next_offset: null,
  });
  const atEof = await files.read({ path: FIXTURES.source.path, offset: FIXTURES.source.bytes });
  assert.deepEqual([atEof.text, atEof.returned_bytes, atEof.next_offset], ['', 0, null]);

  await put('docs/split.txt', 'a😀b');
  for (const range of [
    { offset: 7 },
    { offset: 2 },
    { offset: -1 },
    { offset: 1.5 },
    { max_bytes: 3 },
    { max_bytes: 32769 },
    { max_bytes: 4.5 },
  ]) {
    await assert.rejects(files.read({ path: 'docs/split.txt', ...range }), rejectsWith('invalid_range'), JSON.stringify(range));
  }

  await put('docs/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await assert.rejects(files.read({ path: 'docs/latin1.txt' }), rejectsWith('unsupported_content'));
  await put('docs/nul.txt', 'before\0after');
  await assert.rejects(files.read({ path: 'docs/nul.txt' }), rejectsWith('unsupported_content'));

  await put('docs/at-limit.txt', Buffer.alloc(2 * 1024 * 1024, 0x61));
  assert.equal((await files.read({ path: 'docs/at-limit.txt' })).bytes, 2 * 1024 * 1024);
  await put('docs/too-large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  await assert.rejects(files.read({ path: 'docs/too-large.txt' }), rejectsWith('too_large'));
});

test('rejects paths that leave the root, directly or through symlinks', async () => {
  await writeFile(join(sandbox, 'outside.txt'), 'outside the repository');
  await mkdir(join(sandbox, 'repo-evil'), { recursive: true });
  await writeFile(join(sandbox, 'repo-evil', 'secret.txt'), 'sibling with a similar prefix');
  await put('.env', 'TOKEN=fixture-only');
  await mkdir(join(root, 'links'), { recursive: true });
  await symlink('../../outside.txt', join(root, 'links', 'outside'));
  await symlink('../../repo-evil/secret.txt', join(root, 'links', 'sibling'));
  await symlink(join(sandbox, 'repo-evil'), join(root, 'links', 'evil-dir'));
  await symlink('../bridge/src/sample.ts', join(root, 'links', 'sample.ts'));
  await symlink('../.env', join(root, 'links', 'innocent.txt'));

  for (const path of [
    '',
    '/etc/hostname',
    join(root, FIXTURES.source.path),
    '..',
    '../repo-evil/secret.txt',
    'bridge/../bridge/src/sample.ts',
    'bridge\\src\\sample.ts',
    'bridge/src/sample.ts\0',
    'x'.repeat(4097),
  ]) {
    await assert.rejects(files.read({ path }), rejectsWith('invalid_path'), JSON.stringify(path.slice(0, 40)));
  }
  for (const path of ['links/outside', 'links/sibling', 'links/evil-dir/secret.txt', 'links/innocent.txt']) {
    await assert.rejects(files.read({ path }), rejectsWith('forbidden_path'), path);
  }

  const viaLink = await files.read({ path: 'links/sample.ts' });
  assert.equal(viaLink.path, 'links/sample.ts');
  assert.equal(viaLink.sha256, FIXTURES.source.sha256);
  assert.equal(viaLink.text, FIXTURES.source.text);
});

test('refuses .git and credential-style files, allows the documented exceptions, reports missing files and non-files', async () => {
  const forbidden = [
    '.git/config',
    '.git/HEAD',
    'bridge/.git/anything',
    '.env',
    '.env.local',
    'config/.env.production',
    '.npmrc',
    'home/.netrc',
    '.git-credentials',
    'keys/id_rsa',
    'keys/id_ed25519',
    'certs/server.key',
    'certs/client.P12',
    'certs/client.pfx',
  ];
  for (const path of forbidden) {
    if (!path.startsWith('.git/')) {
      await put(path, 'fixture-only, not a real credential\n');
    }
    await assert.rejects(files.read({ path }), rejectsWith('forbidden_path'), path);
  }

  for (const path of ['.env.example', '.env.sample', '.env.template']) {
    await put(path, 'API_URL=http://127.0.0.1:8787\n');
    assert.equal((await files.read({ path })).text, 'API_URL=http://127.0.0.1:8787\n');
  }
  assert.equal((await files.read({ path: '.gitignore' })).text, 'review/\n');

  await assert.rejects(files.read({ path: 'docs/missing.md' }), rejectsWith('not_found'));
  await assert.rejects(files.read({ path: 'bridge/src/sample.ts/child' }), rejectsWith('not_found'));
  await assert.rejects(files.read({ path: 'bridge/src' }), rejectsWith('unsupported_type'));
  execFileSync('mkfifo', [join(root, 'docs', 'pipe')]);
  await assert.rejects(files.read({ path: 'docs/pipe' }), rejectsWith('unsupported_type'));
});
