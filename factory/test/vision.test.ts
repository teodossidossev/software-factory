// A workspace's vision (src/vision.ts): the store's layout and modes, a put of en then bg and a
// second put of en, every refusal with nothing changed, two puts at once, the removes, the index,
// the pages and a page's read, the folder sf serve makes at its start, and the sf vision commands
// through the table.
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { answerLines, checkArgs, type Command, COMMANDS, type Serve } from '../src/commands.js';
import { FactoryError } from '../src/errors.js';
import { type SocketHandlerOptions, socketHandler } from '../src/ipc-handlers.js';
import { saveRegistry } from '../src/registry.js';
import {
  MAX_VISION_CHAPTERS, MAX_VISION_FILE_BYTES, PAGE_FILE, putVision, readVisionPage, removeVision, visionIndex, visionPages, visionRoot,
} from '../src/vision.js';
import { visionPage } from '../src/vision-page.js';

const temp = (name: string): Promise<string> => mkdtemp(join(tmpdir(), `sf-vision-${name}-`));
const refused = (code: string, message?: string) => (error: unknown): boolean =>
  error instanceof FactoryError && error.code === code && (message === undefined || error.message === message);
const AT = new Date('2026-11-14T11:10:44.000Z');
const LATER = new Date('2026-11-14T11:12:05.000Z');

type Files = Record<string, string | Buffer>;
const BOOKSHOP_EN: Files = {
  'VISION.md': '# Bookshop\n\nV1 (observed) The shop sells books.\n',
  'CODEMAP.md': '# Code map\n\nThe server is in src/.\n',
  'chapters/orders.md': '# Orders\n\nAn order holds books.\n',
  'chapters/customers.md': '# Customers\n\nA customer has an account.\n',
};
const BOOKSHOP_BG: Files = {
  'VISION.md': '# Книжарница\n\nV1 (observed) Магазинът продава книги.\n',
  'chapters/orders.md': '# Поръчки\n\nПоръчката съдържа книги.\n',
};

// A state directory, a configuration directory whose registry holds bookshop (and atlas when asked).
async function setup(name: string, workspaces = ['bookshop']): Promise<{ state: string; config: string; paths: { stateDir: string; configDir: string } }> {
  const root = await temp(name);
  const state = join(root, 'state');
  const config = join(root, 'config');
  await mkdir(state);
  await mkdir(config);
  await saveRegistry({ workspaces: Object.fromEntries(workspaces.map((workspace) => [workspace, { read_checkout: `/srv/${workspace}` }])) }, config);
  return { state, config, paths: { stateDir: state, configDir: config } };
}

// A source folder from a map of relative path to text (or bytes).
async function source(files: Files): Promise<string> {
  const dir = await temp('source');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

const texts = (files: Files): Map<string, string> => new Map(Object.entries(files).map(([path, text]) => [path, String(text)]));

// Every entry under dir: its path, kind and mode, and a file's bytes; a missing dir is none.
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch { // missing: nothing stored
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const stats = await lstat(join(dir, path));
    if (entry.isDirectory()) {
      out.push(`${path}/ ${(stats.mode & 0o777).toString(8)}`, ...(await snapshot(dir, path)));
    } else {
      out.push(`${path} ${(stats.mode & 0o777).toString(8)} ${entry.isFile() ? (await readFile(join(dir, path))).toString('hex') : 'other'}`);
    }
  }
  return out;
}

test('a put of en stores the layout: the bytes, files 0600, folders 0700, the answer, the page; no leftover; no chapters folder without chapters', async () => {
  const { state, paths } = await setup('put-en');
  const dir = await source(BOOKSHOP_EN);
  assert.deepEqual(await putVision(paths, 'bookshop', 'en', dir, AT), { workspace: 'bookshop', lang: 'en', files: 4, updated: AT.toISOString() });
  const home = join(visionRoot(state), 'bookshop');
  assert.deepEqual(await snapshot(home), [
    'en/ 700',
    `en/CODEMAP.md 600 ${Buffer.from(BOOKSHOP_EN['CODEMAP.md']!).toString('hex')}`,
    `en/VISION.md 600 ${Buffer.from(BOOKSHOP_EN['VISION.md']!).toString('hex')}`,
    'en/chapters/ 700',
    `en/chapters/customers.md 600 ${Buffer.from(BOOKSHOP_EN['chapters/customers.md']!).toString('hex')}`,
    `en/chapters/orders.md 600 ${Buffer.from(BOOKSHOP_EN['chapters/orders.md']!).toString('hex')}`,
    `page.html 600 ${Buffer.from(visionPage({ en: texts(BOOKSHOP_EN) })).toString('hex')}`,
  ]);
  assert.equal(((await stat(home)).mode & 0o777), 0o700);
  assert.equal((await stat(join(home, 'en'))).mtime.toISOString(), AT.toISOString());

  const plain = await setup('put-plain');
  await putVision(plain.paths, 'bookshop', 'en', await source({ 'VISION.md': '# Bookshop\n' }), AT);
  assert.deepEqual(await readdir(join(visionRoot(plain.state), 'bookshop', 'en')), ['VISION.md']);
});

test('a put of bg builds the page from both; a second put of en replaces it, keeps bg and rebuilds the page', async () => {
  const { state, paths } = await setup('put-bg');
  await putVision(paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT);
  assert.deepEqual(await putVision(paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), LATER), { workspace: 'bookshop', lang: 'bg', files: 2, updated: LATER.toISOString() });
  const page = (): Promise<string> => readFile(join(visionRoot(state), 'bookshop', PAGE_FILE), 'utf8');
  assert.equal(await page(), visionPage({ en: texts(BOOKSHOP_EN), bg: texts(BOOKSHOP_BG) }));
  const second: Files = { ...BOOKSHOP_EN, 'VISION.md': '# Bookshop\n\nV2 (assumed) Gift cards.\n' };
  delete second['chapters/customers.md'];
  await putVision(paths, 'bookshop', 'en', await source(second), LATER);
  assert.deepEqual(await readdir(join(visionRoot(state), 'bookshop', 'en', 'chapters')), ['orders.md']);
  assert.deepEqual((await readdir(join(visionRoot(state), 'bookshop'))).sort(), ['bg', 'en', PAGE_FILE]);
  assert.equal(await page(), visionPage({ en: texts(second), bg: texts(BOOKSHOP_BG) }));
});

test('every refusal by its code and message; the stored files and the page stay byte for byte', async () => {
  const { state, paths } = await setup('refusals');
  await putVision(paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT);
  await putVision(paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), AT);
  const before = await snapshot(visionRoot(state));
  const put = async (lang: string, dir: string, code: string, message: string, workspace = 'bookshop'): Promise<void> => {
    await assert.rejects(putVision(paths, workspace, lang, dir, LATER), refused(code, message), message);
    assert.deepEqual(await snapshot(visionRoot(state)), before, message);
  };
  const good = await source(BOOKSHOP_EN);
  for (const lang of ['EN', 'de', 'e', 'en-US', '../x', '']) {
    await put(lang, good, 'invalid_language', `The language must be bg or en, got ${JSON.stringify(lang)}.`);
  }
  await put('x'.repeat(30), good, 'invalid_language', `The language must be bg or en, got "${'x'.repeat(20)}".`);
  await put('en', good, 'workspace_not_found', 'Workspace "atlas" is not registered.', 'atlas');
  const absolute = 'The folder must be an absolute path: sf serve reads it, not your terminal. Give the whole path, such as "$PWD/vision".';
  await put('en', 'vision', 'vision_folder', absolute);
  await put('en', `${good}\0`, 'vision_folder', absolute);
  await put('en', join(good, 'missing'), 'vision_folder', 'The folder cannot be read (ENOENT).');
  await put('en', join(good, 'VISION.md'), 'vision_folder', 'The folder cannot be read (ENOTDIR).');

  const linked = await source({ 'chapters/orders.md': '# Orders\n' });
  await symlink(join(good, 'VISION.md'), join(linked, 'VISION.md'));
  await put('en', linked, 'vision_entry', '"VISION.md": a symbolic link; a vision holds plain files only.');
  const linkedChapter = await source({ 'VISION.md': '# V\n' });
  await mkdir(join(linkedChapter, 'chapters'));
  await symlink(join(good, 'chapters', 'orders.md'), join(linkedChapter, 'chapters', 'orders.md'));
  await put('en', linkedChapter, 'vision_entry', '"chapters/orders.md": a symbolic link; a vision holds plain files only.');
  const notes = await source({ 'VISION.md': '# V\n', 'notes.txt': 'x' });
  await put('en', notes, 'vision_entry', '"notes.txt": not part of a vision; its folder holds VISION.md, CODEMAP.md and chapters/<name>.md only.');
  const long = await source({ 'VISION.md': '# V\n', ['n'.repeat(100)]: 'x' });
  await put('en', long, 'vision_entry', `"${'n'.repeat(80)}": not part of a vision; its folder holds VISION.md, CODEMAP.md and chapters/<name>.md only.`);
  await put('en', await source({ 'VISION.md': '# V\n', chapters: 'x' }), 'vision_entry', '"chapters": not a folder.');
  const visionDir = await source({ 'VISION.md/x': 'x' });
  await put('en', visionDir, 'vision_entry', '"VISION.md": not a regular file.');
  const chapterDir = await source({ 'VISION.md': '# V\n', 'chapters/sub.md/x': 'x' });
  await put('en', chapterDir, 'vision_entry', '"chapters/sub.md": not a regular file.');
  await put('en', await source({ 'VISION.md': '# V\n', 'chapters/My notes.md': 'x' }), 'vision_entry',
    '"chapters/My notes.md": not a chapter\'s name; it is a lower-case letter or digit, then up to 60 lower-case letters, digits or "-", then ".md".');
  await put('en', await source({ 'CODEMAP.md': '# C\n' }), 'vision_entry', '"VISION.md": missing; a vision needs it.');

  const chapters = (count: number): Files => Object.fromEntries([['VISION.md', '# V\n'], ...Array.from({ length: count }, (_, index) => [`chapters/c${index}.md`, `# C${index}\n`])]);
  await put('en', await source(chapters(MAX_VISION_CHAPTERS + 1)), 'vision_too_large', 'The folder has 65 chapters; at most 64.');
  await put('en', await source({ 'VISION.md': 'a'.repeat(MAX_VISION_FILE_BYTES + 1) }), 'vision_too_large', '"VISION.md": 524289 bytes; at most 524288.');
  const big = 'a'.repeat(MAX_VISION_FILE_BYTES);
  await put('en', await source({ 'VISION.md': big, 'CODEMAP.md': big, 'chapters/a.md': big, 'chapters/b.md': big, 'chapters/c.md': 'a' }), 'vision_too_large',
    'The folder\'s files have more than 2097152 bytes together.');
  await put('en', await source({ 'VISION.md': Buffer.from([0x23, 0xff, 0x0a]) }), 'vision_not_text', '"VISION.md": not UTF-8 text.');
  await put('en', await source({ 'VISION.md': '# V\n', 'chapters/nul.md': 'a\0b' }), 'vision_not_text', '"chapters/nul.md": not UTF-8 text.');

  await assert.rejects(removeVision(state, 'bookshop', 'en'), refused('vision_needs_en',
    'The English vision of bookshop is the source of its page; remove bg first, or the whole vision (sf vision remove bookshop).'));
  await assert.rejects(removeVision(state, 'bookshop', 'de'), refused('invalid_language', 'The language must be bg or en, got "de".'));
  assert.deepEqual(await snapshot(visionRoot(state)), before);

  // A put of bg with no en stored.
  const empty = await setup('needs-en');
  await assert.rejects(putVision(empty.paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), AT), refused('vision_needs_en',
    'bookshop has no English vision; store it first (sf vision put bookshop en <dir>): the page is built from it.'));
  assert.deepEqual(await snapshot(visionRoot(empty.state)), []);
  // The bounds themselves are stored.
  assert.equal((await putVision(empty.paths, 'bookshop', 'en', await source(chapters(MAX_VISION_CHAPTERS)), AT)).files, 65);
  assert.equal((await putVision(empty.paths, 'bookshop', 'en', await source({ 'VISION.md': big }), AT)).files, 1);
});

test('two puts of en started together both resolve; the store holds one source whole, nothing left over', async () => {
  const { state, paths } = await setup('together');
  const one = { 'VISION.md': '# One\n', 'chapters/a.md': '# A\n' };
  const two = { 'VISION.md': '# Two\n', 'CODEMAP.md': '# Map\n', 'chapters/b.md': '# B\n' };
  const [first, second] = await Promise.all([putVision(paths, 'bookshop', 'en', await source(one), AT), putVision(paths, 'bookshop', 'en', await source(two), AT)]);
  assert.deepEqual([first.files, second.files], [2, 3]);
  const home = join(visionRoot(state), 'bookshop');
  assert.deepEqual((await readdir(home)).sort(), ['en', PAGE_FILE]);
  const stored = (await snapshot(join(home, 'en'))).filter((line) => !line.endsWith('/ 700')).map((line) => line.split(' ')[0]);
  assert.ok([['VISION.md', 'chapters/a.md'], ['CODEMAP.md', 'VISION.md', 'chapters/b.md']].some((paths) => JSON.stringify(paths) === JSON.stringify(stored)), stored.join(', '));
  assert.equal(await readFile(join(home, PAGE_FILE), 'utf8'), visionPage({ en: texts(stored.length === 2 ? one : two) }));
});

test('remove: bg (the page from en), every language, en alone; the refusals; a workspace not in the registry', async () => {
  const { state, paths } = await setup('remove', ['bookshop', 'atlas']);
  const home = join(visionRoot(state), 'bookshop');
  const both = async (): Promise<void> => {
    await putVision(paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT);
    await putVision(paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), AT);
  };
  await both();
  assert.deepEqual(await removeVision(state, 'bookshop', 'bg'), { workspace: 'bookshop', removed: ['bg'] });
  assert.deepEqual((await readdir(home)).sort(), ['en', PAGE_FILE]);
  assert.equal(await readFile(join(home, PAGE_FILE), 'utf8'), visionPage({ en: texts(BOOKSHOP_EN) }));
  await assert.rejects(removeVision(state, 'bookshop', 'bg'), refused('vision_not_found', 'bookshop has no vision in bg.'));
  assert.deepEqual(await removeVision(state, 'bookshop', 'en'), { workspace: 'bookshop', removed: ['en'] });
  await assert.rejects(stat(home), { code: 'ENOENT' });
  await both();
  assert.deepEqual(await removeVision(state, 'bookshop'), { workspace: 'bookshop', removed: ['bg', 'en'] });
  await assert.rejects(stat(home), { code: 'ENOENT' });
  await assert.rejects(removeVision(state, 'bookshop'), refused('vision_not_found', 'bookshop has no vision.'));
  await assert.rejects(removeVision(state, '../x'), refused('vision_not_found', '../x has no vision.'));
  // A workspace that left the registry keeps its vision, and it can be removed.
  await putVision(paths, 'atlas', 'en', await source(BOOKSHOP_EN), AT);
  await saveRegistry({ workspaces: { bookshop: { read_checkout: '/srv/bookshop' } } }, paths.configDir);
  assert.deepEqual((await visionIndex(state)).visions.map((vision) => vision.workspace), ['atlas']);
  assert.deepEqual(await removeVision(state, 'atlas'), { workspace: 'atlas', removed: ['en'] });
  assert.deepEqual(await readdir(visionRoot(state)), []);
});

test('visionIndex, visionPages and readVisionPage: sorted, files and updated; bad names, links, leftovers skipped; a missing root is none', async () => {
  const missing = await temp('none');
  assert.deepEqual([await visionIndex(missing), await visionPages(missing), await readVisionPage(missing, 'bookshop')], [{ visions: [] }, [], undefined]);
  const { state, paths } = await setup('index', ['bookshop', 'atlas']);
  await putVision(paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT);
  await putVision(paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), LATER);
  await putVision(paths, 'atlas', 'en', await source({ 'VISION.md': '# Atlas\n' }), AT);
  const root = visionRoot(state);
  // Skipped: a folder with a bad name, a language folder without VISION.md, a leftover .en.old, a
  // link to a workspace's folder, a chapter with a bad name, a page.html that is a link.
  await mkdir(join(root, 'Bad_Name', 'en'), { recursive: true });
  await writeFile(join(root, 'Bad_Name', 'en', 'VISION.md'), '# Bad\n');
  await writeFile(join(root, 'Bad_Name', PAGE_FILE), 'x');
  await mkdir(join(root, 'cafe', 'en'), { recursive: true });
  await writeFile(join(root, 'cafe', PAGE_FILE), 'cafe');
  await mkdir(join(root, 'bookshop', '.en.old'));
  await writeFile(join(root, 'bookshop', '.en.old', 'VISION.md'), '# Old\n');
  await symlink(join(root, 'bookshop'), join(root, 'linked'));
  await writeFile(join(root, 'bookshop', 'en', 'chapters', 'Notes.md'), '# Notes\n');
  await mkdir(join(root, 'paged'));
  await symlink(join(root, 'bookshop', PAGE_FILE), join(root, 'paged', PAGE_FILE));
  assert.deepEqual(await visionIndex(state), {
    visions: [
      { workspace: 'atlas', languages: [{ lang: 'en', files: 1, updated: AT.toISOString() }] },
      { workspace: 'bookshop', languages: [{ lang: 'bg', files: 2, updated: LATER.toISOString() }, { lang: 'en', files: 4, updated: AT.toISOString() }] },
    ],
  });
  assert.deepEqual(await visionPages(state), ['atlas', 'bookshop', 'cafe']);
  assert.equal((await readVisionPage(state, 'bookshop'))!.toString('utf8'), await readFile(join(root, 'bookshop', PAGE_FILE), 'utf8'));
  assert.equal((await readVisionPage(state, 'cafe'))!.toString('utf8'), 'cafe');
  for (const name of ['../x', 'Bad_Name', 'paged', 'linked', 'web']) {
    assert.equal(await readVisionPage(state, name), undefined, name);
  }
});

test('a link in place of a folder of the store is never followed: refused before any write, or read as nothing; the folder it points to stays as it was', async () => {
  // The outside folder a link points to, with a vision of its own.
  const outside = await source({ 'en/VISION.md': '# Outside\n\nOutside secret.\n', 'en/chapters/leak.md': '# Leak\n\nOutside chapter.\n', [PAGE_FILE]: 'outside page' });
  const untouched = await snapshot(outside);
  const unsafeRefusal = (entry: string) => refused('vision_unsafe', `"${entry}" in the store is not a plain folder; nothing was changed.`);

  // The vision root, then the workspace's folder, a link.
  const rooted = await setup('link-root');
  await symlink(outside, visionRoot(rooted.state));
  await assert.rejects(putVision(rooted.paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT), unsafeRefusal('vision'));
  const linked = await setup('link-home');
  await mkdir(visionRoot(linked.state));
  await symlink(outside, join(visionRoot(linked.state), 'bookshop'));
  await assert.rejects(putVision(linked.paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT), unsafeRefusal('vision/bookshop'));
  await assert.rejects(removeVision(linked.state, 'bookshop'), refused('vision_not_found', 'bookshop has no vision.'));
  for (const state of [rooted.state, linked.state]) {
    assert.deepEqual([await visionIndex(state), await visionPages(state), await readVisionPage(state, 'bookshop')], [{ visions: [] }, [], undefined]);
  }

  // A stored language's chapters, then the language's folder, a link.
  const { state, paths } = await setup('link-lang');
  await putVision(paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT);
  const en = join(visionRoot(state), 'bookshop', 'en');
  await rm(join(en, 'chapters'), { recursive: true });
  await symlink(join(outside, 'en', 'chapters'), join(en, 'chapters'));
  await putVision(paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), AT);
  const page = await readFile(join(visionRoot(state), 'bookshop', PAGE_FILE), 'utf8');
  assert.equal(page, visionPage({ en: texts({ 'VISION.md': BOOKSHOP_EN['VISION.md']!, 'CODEMAP.md': BOOKSHOP_EN['CODEMAP.md']! }), bg: texts(BOOKSHOP_BG) }));
  assert.equal((await visionIndex(state)).visions[0]!.languages.find((stored) => stored.lang === 'en')!.files, 2);
  await assert.rejects(removeVision(state, 'bookshop', 'en'), refused('vision_needs_en'));
  await removeVision(state, 'bookshop', 'bg');
  await rm(en, { recursive: true });
  await symlink(join(outside, 'en'), en);
  await assert.rejects(putVision(paths, 'bookshop', 'bg', await source(BOOKSHOP_BG), AT), refused('vision_needs_en'));
  await assert.rejects(removeVision(state, 'bookshop'), refused('vision_not_found', 'bookshop has no vision.'));
  // A put of en replaces the link itself with the new folder.
  await putVision(paths, 'bookshop', 'en', await source(BOOKSHOP_EN), AT);
  assert.equal((await lstat(en)).isDirectory(), true);
  assert.deepEqual(await snapshot(outside), untouched);
});

test('sf serve\'s socket handler makes <state>/vision at its start, the state directory too, both 0700; an existing one keeps its mode', async () => {
  const state = join(await temp('serve'), 'state');
  socketHandler({ stateDir: state } as unknown as SocketHandlerOptions);
  assert.deepEqual([((await stat(state)).mode & 0o777), ((await stat(visionRoot(state))).mode & 0o777)], [0o700, 0o700]);
  const open = await temp('open');
  await mkdir(visionRoot(open));
  await chmod(visionRoot(open), 0o755);
  socketHandler({ stateDir: open } as unknown as SocketHandlerOptions);
  assert.equal(((await stat(visionRoot(open))).mode & 0o777), 0o755);
});

test('sf vision through the command table: put, the list, remove; the word counts, the name; open while updating: the list only', async () => {
  const { state, config } = await setup('table');
  const before = { state: process.env.SF_STATE_DIR, config: process.env.SF_CONFIG_DIR };
  process.env.SF_STATE_DIR = state;
  process.env.SF_CONFIG_DIR = config;
  const shown = async (command: Command, args: string[]): Promise<string[]> => {
    const answer = answerLines(command, await command.run({} as Serve, checkArgs(command, args).args, {}) as Record<string, unknown>, {});
    assert.equal(answer.failed, false);
    return answer.lines;
  };
  try {
    assert.deepEqual(await shown(COMMANDS.vision, []), ['No workspace has a vision (sf vision put <workspace> en <dir> stores one).']);
    assert.deepEqual(await shown(COMMANDS.visionPut, ['bookshop', 'en', await source(BOOKSHOP_EN)]), ['Stored the vision of bookshop (en): 4 files.']);
    assert.deepEqual(await shown(COMMANDS.visionPut, ['bookshop', 'bg', await source({ 'VISION.md': '# Книжарница\n' })]), ['Stored the vision of bookshop (bg): 1 file.']);
    const lines = await shown(COMMANDS.vision, []);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'workspace  language  files  updated');
    assert.match(lines[1]!, /^bookshop   bg        1      \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.match(lines[2]!, /^bookshop   en        4      \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.deepEqual(await shown(COMMANDS.visionRemove, ['bookshop', 'bg']), ['Removed the vision of bookshop (bg).']);
    await shown(COMMANDS.visionPut, ['bookshop', 'bg', await source({ 'VISION.md': '# Книжарница\n' })]);
    assert.deepEqual(await shown(COMMANDS.visionRemove, ['bookshop']), ['Removed the vision of bookshop (bg, en).']);
  } finally {
    for (const [name, value] of [['SF_STATE_DIR', before.state], ['SF_CONFIG_DIR', before.config]] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  assert.throws(() => checkArgs(COMMANDS.visionPut, ['bookshop', 'en']), refused('bad_request', 'vision put needs <workspace> <lang> <dir>.'));
  assert.throws(() => checkArgs(COMMANDS.visionPut, ['Bad_Name', 'en', '/x']), refused('invalid_name'));
  assert.throws(() => checkArgs(COMMANDS.visionRemove, ['Bad_Name']), refused('invalid_name'));
  assert.deepEqual([COMMANDS.vision.openWhileUpdating, 'openWhileUpdating' in COMMANDS.visionPut, 'openWhileUpdating' in COMMANDS.visionRemove], [true, false, false]);
});
