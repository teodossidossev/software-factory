// The vision page (src/vision-page.ts): the page for an invented product, Bookshop, in both
// languages and in English alone, the escaping of what a file holds, the three fixes where the
// port differs from the pilot's builder, and the builder's style and script byte for byte.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { VISION_PAGE_SCRIPT, VISION_PAGE_STYLE, visionPage } from '../src/vision-page.js';

const filesOf = (entries: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(entries));
const count = (text: string, part: string): number => text.split(part).length - 1;

// The article with this id, up to its first </article>.
function article(page: string, id: string): string {
  const start = page.indexOf(`<article class="doc" id="${id}"`);
  assert.notEqual(start, -1, `no article ${id}`);
  const end = page.indexOf('</article>', start);
  return page.slice(start, end + '</article>'.length);
}

const EN_VISION = `# Bookshop: what it is

The shop sells books. The chapters: \`chapters/orders.md\` and \`chapters/customers.md\`.

- **Q1** [assumed] May a guest order?

Orders follow ORD-R1; see orders.md, NOPE-X9 and <script>alert(1)</script> & co.
`;

const EN = filesOf({
  'VISION.md': EN_VISION,
  'chapters/orders.md': `# Orders: from basket to delivery

## Lines

- **ORD-R1** [observed] An order has at least one line. Evidence: \`src/orders/order.ts:12\`, \`src/orders/line.ts:3\`
- **ORD-R2 = CUS-R1** [assumed; customers, payments] An order belongs to one customer, see CUS-R1. (verified by the merger)

## Totals

**ORD-R3** [observed, from the API] The total is *the sum* of the lines.

## Fields

| Field | Rule |
| --- | --- |
| total | ORD-R3 \`[observed]\` |
`,
  'chapters/customers.md': `# Customers

**CUS-R1** [observed] A customer has an e-mail address.
`,
  'CODEMAP.md': `# Code map

| Directory | Chapter |
| --- | --- |
| \`src/orders\` | \`chapters/orders.md\` |
`,
});

const BG = filesOf({
  'VISION.md': `# Книжарница: какво е

Магазинът продава книги. Главите: \`chapters/orders.md\` и \`chapters/customers.md\`.

- **Q1** [assumed] Може ли гост да поръча?

Поръчките следват ORD-R1; виж orders.md, NOPE-X9 и <script>alert(1)</script> & co.
`,
  'chapters/orders.md': `# Поръчки: от кошницата до доставката

## Редове

- **ORD-R1** [observed] Поръчката има поне един ред. Доказателство: \`src/orders/order.ts:12\`, \`src/orders/line.ts:3\`
- **ORD-R2 = CUS-R1** [assumed; customers, payments] Поръчката е на един клиент, виж CUS-R1. (verified by the merger)

## Суми

**ORD-R3** [observed, от API] Сумата е *сборът* на редовете.

## Полета

| Поле | Правило |
| --- | --- |
| total | ORD-R3 \`[observed]\` |
`,
  'CODEMAP.md': `# Карта на кода

| Папка | Глава |
| --- | --- |
| \`src/orders\` | \`chapters/orders.md\` |
`,
});

const RADIOS = '<input type="radio" name="L" id="L-bg" class="lr" checked><input type="radio" name="L" id="L-en" class="lr">';

test('Bookshop in both languages: the builder\'s page', () => {
  const page = visionPage({ en: EN, bg: BG });
  assert.ok(page.startsWith('<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Книжарница: какво е</title><style>'));
  assert.ok(page.endsWith(`<script>${VISION_PAGE_SCRIPT}</script></body></html>`));
  for (const part of [`<style>${VISION_PAGE_STYLE}</style>`, RADIOS, `<script>${VISION_PAGE_SCRIPT}</script>`,
    '<div class="lang" id="bg" lang="bg">', '<div class="lang" id="en" lang="en">']) {
    assert.equal(count(page, part), 1, part);
  }
  assert.ok(page.indexOf('<div class="lang" id="bg" lang="bg">') < page.indexOf('<div class="lang" id="en" lang="en">'));
  assert.ok(page.includes('<nav><div class="navh">Contents</div><a class="d" href="#en~VISION" title="Bookshop: what it is">Bookshop</a><div class="g">Chapters</div><a class="d" href="#en~orders" title="Orders: from basket to delivery">Orders</a><a class="d" href="#en~customers" title="Customers">Customers</a><div class="g"></div><a class="d" href="#en~CODEMAP" title="Code map">Code map</a><p class="legend">Badges: "observed" is shown by the code; "assumed" is inferred; the grey ones say where a statement comes from.</p></nav>'));
  assert.equal(article(page, 'en~VISION'), '<article class="doc" id="en~VISION" data-title="Bookshop"><h1 id="en~VISION~1">Bookshop: what it is</h1><p id="en~VISION~2" class="s">The shop sells books. The chapters: <a href="#en~orders"><code>chapters/orders.md</code></a> and <a href="#en~customers"><code>chapters/customers.md</code></a>.</p><ul id="en~VISION~3"><li class="s" id="en~VISION~3~1"><span class="id" id="en~Q1">Q1</span> <span class="b assumed">assumed</span> May a guest order?</li></ul><p id="en~VISION~4" class="s">Orders follow <a class="ref" href="#en~ORD-R1">ORD-R1</a>; see <a href="#en~orders">orders.md</a>, NOPE-X9 and &lt;script&gt;alert(1)&lt;/script&gt; &amp; co.</p><footer class="pn"><span></span><a href="#en~orders">Orders →</a></footer></article>');
  assert.equal(article(page, 'en~orders'), '<article class="doc" id="en~orders" data-title="Orders"><h1 id="en~orders~1">Orders: from basket to delivery</h1><details class="toc" open><summary>In this document</summary><ul><li><a href="#en~orders~2">Lines</a></li><li><a href="#en~orders~4">Totals</a></li><li><a href="#en~orders~6">Fields</a></li></ul></details><h2 id="en~orders~2" class="s">Lines</h2><ul id="en~orders~3"><li class="s" id="en~orders~3~1"><span class="id" id="en~ORD-R1">ORD-R1</span> <span class="b observed">observed</span> An order has at least one line.<details class="ev"><summary>Evidence · 2</summary><div><code>src/orders/order.ts:12</code>, <code>src/orders/line.ts:3</code></div></details></li><li class="s" id="en~orders~3~2"><span class="id" id="en~ORD-R2">ORD-R2</span> <span class="id" id="en~CUS-R1">CUS-R1</span> <span class="b assumed">assumed</span> <span class="in">in <a href="#en~customers">customers</a>, payments</span> An order belongs to one customer, see <a class="ref" href="#en~CUS-R1">CUS-R1</a>. <span class="b mu">verified by the merger</span></li></ul><h2 id="en~orders~4" class="s">Totals</h2><div id="en~orders~5" class="s st"><span class="id" id="en~ORD-R3">ORD-R3</span> <span class="b observed">observed</span> <span class="in">(from the API)</span> The total is <em>the sum</em> of the lines.</div><h2 id="en~orders~6" class="s">Fields</h2><div class="tw" id="en~orders~7"><table><thead><tr><th>Field</th><th>Rule</th></tr></thead><tbody><tr class="s"><td>total</td><td><a class="ref" href="#en~ORD-R3">ORD-R3</a> <span class="b observed">observed</span></td></tr></tbody></table></div><footer class="pn"><a href="#en~VISION">← Bookshop</a><a href="#en~customers">Customers →</a></footer></article>');
  assert.equal(article(page, 'bg~customers'), '<article class="doc" id="bg~customers" data-title="Customers"><h1 id="bg~customers~1">Customers</h1><p class="note">Този документ още не е преведен; показан е на английски.</p><div id="bg~customers~2" class="s st"><a class="id" href="#bg~CUS-R1">CUS-R1</a> <span class="b observed">от кода</span> A customer has an e-mail address.</div><footer class="pn"><a href="#bg~orders">← Поръчки</a><a href="#bg~CODEMAP">Карта на кода →</a></footer></article>');
  for (const lang of ['en', 'bg']) {
    assert.equal(count(page, `id="${lang}~CUS-R1"`), 1, lang);
    assert.ok(article(page, `${lang}~orders`).includes(`id="${lang}~CUS-R1"`), lang);
  }
  assert.ok(!page.includes('href="#en~NOPE-X9"'));
});

test('English alone, without chapters: the Bulgarian block shows the English files with the note', () => {
  const page = visionPage({ en: filesOf({ 'VISION.md': EN_VISION }) });
  assert.ok(page.includes('<title>Bookshop: what it is</title>'));
  const english = page.slice(page.indexOf('<div class="lang" id="en" lang="en">'));
  assert.ok(!english.includes('class="note"'));
  assert.ok(page.includes('<nav><div class="navh">Съдържание</div><a class="d" href="#bg~VISION" title="Bookshop: what it is">Bookshop</a><p class="legend">Значките: „от кода“ се вижда в кода; „предположение“ е извод; сивите уточняват откъде идва твърдението.</p></nav>'));
  assert.equal(article(page, 'bg~VISION'), '<article class="doc" id="bg~VISION" data-title="Bookshop"><h1 id="bg~VISION~1">Bookshop: what it is</h1><p class="note">Този документ още не е преведен; показан е на английски.</p><p id="bg~VISION~2" class="s">The shop sells books. The chapters: <code>chapters/orders.md</code> and <code>chapters/customers.md</code>.</p><ul id="bg~VISION~3"><li class="s" id="bg~VISION~3~1"><span class="id" id="bg~Q1">Q1</span> <span class="b assumed">предположение</span> May a guest order?</li></ul><p id="bg~VISION~4" class="s">Orders follow ORD-R1; see orders.md, NOPE-X9 and &lt;script&gt;alert(1)&lt;/script&gt; &amp; co.</p><footer class="pn"><span></span><span></span></footer></article>');
});

test('escaping: a file adds no markup, no script and no link of its own', () => {
  const page = visionPage({ en: filesOf({ 'VISION.md': '# Say "hi" & <wave>\n\n```\n</script><b>\n```\n' }) });
  assert.ok(page.includes('<title>Say &quot;hi&quot; &amp; &lt;wave&gt;</title>'));
  assert.equal(count(page, '<script'), 1);
  assert.ok(!page.includes(' src='));
  const hrefs = [...page.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
  assert.ok(hrefs.length > 0);
  assert.deepEqual(hrefs.filter((href) => !href.startsWith('#')), []);
  assert.equal(article(page, 'en~VISION'), '<article class="doc" id="en~VISION" data-title="Say &quot;hi&quot; &amp; &lt;wave&gt;"><h1 id="en~VISION~1">Say "hi" &amp; &lt;wave&gt;</h1><pre id="en~VISION~2">&lt;/script&gt;&lt;b&gt;</pre><footer class="pn"><span></span><span></span></footer></article>');
});

test('the fixes: no VISION.md throws, a #line is a paragraph, one level-1 heading leads, NUL is dropped', () => {
  assert.throws(() => visionPage({ en: filesOf({ 'CODEMAP.md': '# Code map\n' }) }), {
    message: 'visionPage: the English files have no VISION.md.',
  });
  const only = (text: string): string => visionPage({ en: filesOf({ 'VISION.md': text }) });

  assert.equal(article(only('# One\n\n#hashtag line\n##### five\n'), 'en~VISION'), '<article class="doc" id="en~VISION" data-title="One"><h1 id="en~VISION~1">One</h1><p id="en~VISION~2" class="s">#hashtag line</p><p id="en~VISION~3" class="s">##### five</p><footer class="pn"><span></span><span></span></footer></article>');

  const two = only('# First\n\ntext\n\n# Second\n\nmore\n');
  assert.ok(!two.includes('\u0001'));
  assert.ok(two.includes('<title>Second</title>'));
  assert.equal(article(two, 'bg~VISION'), '<article class="doc" id="bg~VISION" data-title="Second"><h1 id="bg~VISION~1">First</h1><p class="note">Този документ още не е преведен; показан е на английски.</p><p id="bg~VISION~2" class="s">text</p><h1 id="bg~VISION~3">Second</h1><p id="bg~VISION~4" class="s">more</p><footer class="pn"><span></span><span></span></footer></article>');

  const nul = only('# N\0ul\n\nA\0B\n');
  assert.ok(!nul.includes('\0'));
  assert.equal(article(nul, 'en~VISION'), '<article class="doc" id="en~VISION" data-title="Nul"><h1 id="en~VISION~1">Nul</h1><p id="en~VISION~2" class="s">AB</p><footer class="pn"><span></span><span></span></footer></article>');
});

test('the style and the script are the builder\'s, byte for byte', () => {
  const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(sha(VISION_PAGE_STYLE), 'af75debc2fad0d8b53a906ef71ff070d51ffd392947905ee8d6d6873d6185c61');
  assert.equal(sha(VISION_PAGE_SCRIPT), '8900b99545c95bd97fca78ba798f4d4b79491bb188d629ff76519b743a5155d0');
});
