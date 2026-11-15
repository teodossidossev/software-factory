// The vision page: one self-contained HTML page from a workspace's vision, its Markdown files in
// English and, when given, in Bulgarian. English is the source: the documents and the ids come from
// the English files, and the Bulgarian block shows each document from its Bulgarian file, or from
// the English one with a note. The page is the pilot's builder's, character for character, but
// that a paragraph always takes its first line, that only the first level-1 heading is followed by
// the note and the box, and that NUL characters are dropped from each file first.

export const VISION_LANGUAGES = ['bg', 'en'] as const;
export type VisionLanguage = (typeof VISION_LANGUAGES)[number];
// A vision's files by language, each a map of its path (VISION.md, CODEMAP.md,
// chapters/<name>.md) to its text. English is required; Bulgarian is its translation.
export interface VisionFiles { en: ReadonlyMap<string, string>; bg?: ReadonlyMap<string, string> }

// The page's texts; prev, next and top are the builder's and unused.
const UI = {
  bg: {
    name: 'БГ',
    title: 'Визия',
    contents: 'Съдържание',
    chapters: 'Глави',
    search: 'Търси по текст или идентификатор',
    observed: 'от кода',
    assumed: 'предположение',
    evidence: 'Доказателство',
    in: 'в',
    back: 'Назад',
    here: 'В този документ',
    prev: 'Предишен',
    next: 'Следващ',
    none: 'Няма съвпадения.',
    more: 'Показани са първите 80.',
    untranslated: 'Този документ още не е преведен; показан е на английски.',
    top: 'Нагоре',
    legend: 'Значките: „от кода“ се вижда в кода; „предположение“ е извод; сивите уточняват откъде идва твърдението.',
    '(server: assumed)': 'сървър: предполага се',
    '(e2e: real backend)': 'e2e: реален бекенд',
    '(e2e: stubbed)': 'e2e: със заглушки',
    '(verified by the merger)': 'проверено при обединяването',
    '(corrected by the verifier)': 'поправено при проверката',
  },
  en: {
    name: 'EN',
    title: 'Vision',
    contents: 'Contents',
    chapters: 'Chapters',
    search: 'Search text or an id',
    observed: 'observed',
    assumed: 'assumed',
    evidence: 'Evidence',
    in: 'in',
    back: 'Back',
    here: 'In this document',
    prev: 'Previous',
    next: 'Next',
    none: 'No matches.',
    more: 'The first 80 are shown.',
    untranslated: '',
    top: 'Top',
    legend: 'Badges: "observed" is shown by the code; "assumed" is inferred; the grey ones say where a statement comes from.',
    '(server: assumed)': 'server: assumed',
    '(e2e: real backend)': 'e2e: real backend',
    '(e2e: stubbed)': 'e2e: stubbed',
    '(verified by the merger)': 'verified by the merger',
    '(corrected by the verifier)': 'corrected by the verifier',
  },
} as const;

// The grey badges: where a statement comes from.
const MARKERS = ['(server: assumed)', '(e2e: real backend)', '(e2e: stubbed)', '(verified by the merger)', '(corrected by the verifier)'] as const;

export const VISION_PAGE_STYLE = `
:root{--bg:#fbfaf7;--fg:#1f2328;--mu:#667085;--line:#e4e2dc;--card:#fff;--acc:#1d4ed8;--ok:#0f7b4a;--okb:#e3f4ea;--as:#9a5b00;--asb:#fdf0d5;--mub:#eef0f3;--code:#f2f1ec;--mark:#fff1a8}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e8eb;--mu:#98a2b3;--line:#2c3038;--card:#1d2026;--acc:#8ab4ff;--ok:#6fd3a0;--okb:#143424;--as:#f0b65a;--asb:#3a2a0c;--mub:#272b33;--code:#22262d;--mark:#5c4a00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;-webkit-text-size-adjust:100%}
.lr{position:absolute;opacity:0;pointer-events:none}
#L-bg:checked~#en,#L-en:checked~#bg{display:none}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:10px;align-items:center;padding:8px 16px;background:var(--card);border-bottom:1px solid var(--line)}
.bar .cur{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
.btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 10px;font:inherit;cursor:pointer;line-height:1.4}
.q{flex:0 1 300px;min-width:90px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:6px 10px;font:inherit;font-size:15px}
.qb{display:none}
@media (max-width:699px){.bar{flex-wrap:wrap}.qb{display:inline-block}.q{display:none;order:9;flex:1 1 100%}.searching .q{display:block}}
.sw{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;flex:none}
.sw label{padding:4px 10px;cursor:pointer;font-size:14px;color:var(--mu)}.sw label.on{background:var(--acc);color:#fff}
@media (prefers-color-scheme:dark){.sw label.on{color:#0b1220}}
.navt{position:absolute;opacity:0;pointer-events:none}
nav{position:fixed;top:0;bottom:0;left:0;width:290px;z-index:8;background:var(--card);border-right:1px solid var(--line);overflow:auto;padding:12px 10px 40px;transform:translateX(-100%);transition:transform .18s}
.navt:checked~nav{transform:none}.shade{display:none;position:fixed;inset:0;z-index:7;background:#0006}.navt:checked~.shade{display:block}
nav .navh{font-weight:700;padding:6px 10px 10px}nav .g{color:var(--mu);font-size:12px;text-transform:uppercase;letter-spacing:.06em;padding:12px 10px 4px}
nav a.d{display:block;padding:6px 10px;border-radius:8px;color:var(--fg);text-decoration:none;font-size:15px;line-height:1.35}
nav a.d:hover{background:var(--mub)}nav a.d.on{background:var(--mub);font-weight:600}
nav .legend{color:var(--mu);font-size:12.5px;line-height:1.45;padding:14px 10px 0;margin:14px 0 0;border-top:1px solid var(--line)}
main{max-width:76ch;margin:0 auto;padding:8px 16px 80px}
@media (min-width:1100px){nav{transform:none;top:51px}.nb,.shade{display:none!important}main{margin-left:calc(290px + max(24px,(100vw - 290px - 76ch)/2))}}
article.doc{padding-top:8px}.paged article.doc:not(.cur){display:none}
h1{font-size:1.55em;line-height:1.25;margin:.8em 0 .5em}h2{font-size:1.2em;line-height:1.3;margin:2em 0 .6em;padding-top:.6em;border-top:1px solid var(--line)}
p,li{overflow-wrap:break-word}li{margin:.35em 0}ul,ol{padding-left:1.3em}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
code{font:13.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:12px;border-radius:8px;overflow:auto}
.id,.ref{font:600 12.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
.id{display:inline-block;padding:4px 6px;border-radius:6px;background:var(--mub);color:var(--fg);margin-right:2px}a.id{color:var(--acc)}
.b{display:inline-block;font-size:11.5px;line-height:1;padding:3px 6px;border-radius:99px;white-space:nowrap;vertical-align:1px}
.b.observed{background:var(--okb);color:var(--ok)}.b.assumed{background:var(--asb);color:var(--as)}.b.mu{background:var(--mub);color:var(--mu)}
.in{color:var(--mu);font-size:.85em}
.st{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.ev{margin-top:6px;color:var(--mu);font-size:13px}.ev summary{cursor:pointer;display:inline-block}.ev div{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;margin-top:4px}
.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:10px 0 18px;font-size:15px}.toc summary{cursor:pointer;color:var(--mu)}.toc ul{margin:.4em 0;columns:2 240px}
.tw{overflow:auto;margin:10px 0}table{border-collapse:collapse;font-size:14px;min-width:100%}th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:var(--mub)}
.note{color:var(--as);background:var(--asb);border-radius:8px;padding:6px 10px;font-size:14px}
.pn{display:flex;justify-content:space-between;gap:12px;margin-top:40px;padding-top:14px;border-top:1px solid var(--line);font-size:15px}
[id]{scroll-margin-top:64px}:target{animation:fl 2.2s}@keyframes fl{0%,40%{background:var(--mark)}}
.res{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;margin:10px 0}.res a{display:block;padding:7px 9px;border-radius:8px;color:var(--fg);font-size:14.5px;line-height:1.4}
.res a:hover{background:var(--mub);text-decoration:none}.res small{color:var(--mu);display:block}.res mark{background:var(--mark);color:inherit}.res p{color:var(--mu);margin:6px 9px;font-size:14px}
`;

// One document at a time, the hash names the place, the language switch keeps it, Back, and search.
export const VISION_PAGE_SCRIPT = String.raw`
(function(){
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
var store={get:function(){try{return localStorage.getItem('vision-lang')}catch(e){return null}},set:function(v){try{localStorage.setItem('vision-lang',v)}catch(e){}}};
var langs=$$('.lang').map(function(e){return e.id});
function lang(){return $('#L-en').checked?'en':'bg'}
function box(l){return document.getElementById(l||lang())}
document.body.classList.add('paged');
$$('.q,.back,.qb').forEach(function(e){e.hidden=false});
$$('.qb').forEach(function(b){b.addEventListener('click',function(){var l=b.closest('.lang');if(l.classList.toggle('searching'))$('.q',l).focus()})});
function show(el,jump){
  var b=el.closest('.lang'),a=el.closest('article.doc'); if(!a) return;
  if(b.id!==lang()){ $('#L-'+b.id).checked=true; store.set(b.id); }
  $$('article.doc',b).forEach(function(d){d.classList.toggle('cur',d===a)});
  $('.cur',$('.bar',b)).textContent=a.dataset.title;
  $$('nav a.d',b).forEach(function(n){n.classList.toggle('on',n.getAttribute('href')==='#'+a.id)});
  $('.res',b).hidden=true;
  if(jump!==false){ if(el===a) window.scrollTo(0,0); else el.scrollIntoView(); }
}
function route(jump){
  var id=decodeURIComponent(location.hash.slice(1)),el=id&&document.getElementById(id);
  if(el&&el.closest('article.doc')) show(el,jump); else show($('article.doc',box()),false);
}
function topBlock(){
  var a=$('article.doc.cur',box()),bs=$$('[id]',a),i;
  for(i=0;i<bs.length;i++){ if(bs[i].getBoundingClientRect().bottom>70) return bs[i]; }
  return a;
}
var seenTop={},tick=0;
function remember(){ tick=0; var t=topBlock(); if(t) seenTop[lang()]=t.id; }
window.addEventListener('scroll',function(){ if(!tick) tick=requestAnimationFrame(remember); },{passive:true});
$$('.lr').forEach(function(r){r.addEventListener('change',function(){
  var to=r.id.slice(2),from=langs.filter(function(l){return l!==to})[0];
  var at=document.getElementById(seenTop[from]||'')||$('article.doc.cur',box(from));
  store.set(to);
  var twin=at&&document.getElementById(to+at.id.slice(from.length));
  if(twin){ history.replaceState(null,'','#'+twin.id); show(twin); remember(); } else route();
})});
var saved=store.get(); if(saved&&document.getElementById('L-'+saved)&&!location.hash) $('#L-'+saved).checked=true;
window.addEventListener('hashchange',function(){ route(); var st=history.state; if(st&&typeof st.y==='number') window.scrollTo(0,st.y); remember(); });
route(!!location.hash);
document.addEventListener('click',function(e){
  var a=e.target.closest('a'); if(!a) return;
  if((a.getAttribute('href')||'').charAt(0)==='#') history.replaceState({y:window.scrollY},'');
  var b=a.closest('.lang'); if(b) $('.navt',b).checked=false;
  if(a.closest('.res')){ $$('.q').forEach(function(q){q.value=''}); $$('.lang').forEach(function(l){l.classList.remove('searching')}); }
});
$$('.back').forEach(function(b){b.addEventListener('click',function(){history.back()})});
function esc(s){return s.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
var index={};
function build(l){ if(index[l]) return index[l];
  return index[l]=$$('article.doc',box(l)).reduce(function(all,a){
    return all.concat($$('.s',a).map(function(el){
      var c=el.cloneNode(true); $$('.ev',c).forEach(function(x){x.remove()});
      var t=c.textContent.replace(/\s+/g,' ').trim(); return {id:el.id||el.closest('[id]').id,doc:a.dataset.title,text:t,low:t.toLowerCase()};
    }));},[]);
}
$$('.q').forEach(function(q){q.addEventListener('input',function(){
  var b=q.closest('.lang'),res=$('.res',b),v=q.value.trim().toLowerCase();
  if(v.length<2){res.hidden=true;return}
  var hits=build(b.id).filter(function(x){return x.low.indexOf(v)>=0});
  hits.sort(function(x,y){return (x.low.indexOf(v)===0?0:1)-(y.low.indexOf(v)===0?0:1)});
  var out=hits.slice(0,80).map(function(x){
    var i=x.low.indexOf(v),s=Math.max(0,i-60),e=Math.min(x.text.length,i+v.length+110);
    return '<a href="#'+x.id+'"><small>'+esc(x.doc)+'</small>'+(s?'…':'')+esc(x.text.slice(s,i))+'<mark>'+esc(x.text.slice(i,i+v.length))+'</mark>'+esc(x.text.slice(i+v.length,e))+(e<x.text.length?'…':'')+'</a>';
  }).join('');
  res.innerHTML=out?out+(hits.length>80?'<p>'+res.dataset.more+' ('+hits.length+')</p>':''):'<p>'+res.dataset.none+'</p>';
  res.hidden=false; window.scrollTo(0,0);
})});
})();
`;

// JavaScript's \b and \w count ASCII letters and digits only; these patterns count every letter
// and digit as a word character, as the builder's Python does.
const ID_TEXT = '(?:[A-Z]{2,4}-[A-Z]\\d+|Q\\d+)';
const ID = new RegExp(`(?<![\\p{L}\\p{N}_])${ID_TEXT}(?![\\p{L}\\p{N}_])`, 'gu');
const JOIN = new RegExp(`^${ID_TEXT}(?: = ${ID_TEXT})*$`, 'u');
const LEAD = /^\*\*([^*]+)\*\*\s*/u;
const EVIDENCE = /\s(?:Evidence|Доказателство):\s/u;
const LINE_REF = /:\d+/g;
const CODE = /`([^`\n]+)`/g;
const BOLD = /\*\*([^*]+)\*\*/g;
const ITALIC = /(?<![\p{L}\p{N}_*])\*([^*\s][^*]*?)\*(?![\p{L}\p{N}_*])/gu;
const STATUS = /\[(observed|assumed)(?:([;,]) ?([^\]]+))?\]/g;
const MD_NAME = /(?<![\p{L}\p{N}_])([a-z0-9-]+)\.md(?![\p{L}\p{N}_])/gu;
const LISTED = /`(chapters\/[a-z0-9-]+\.md)`/g;
const CHAPTER = /^chapters\/[a-z0-9-]+\.md$/;
const HEADING = /^#{1,4} /;
const ITEM = /^(?:- |\d+\. )/;
const TAG = /(<[^>]+>)/;
// The mark that holds a code span's place while the rest of a text is rendered.
const MARK = /\0(\d+)\0/g;
const FENCE = '```';

type Status = 'observed' | 'assumed';
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[] }
  | { kind: 'list'; tag: 'ul' | 'ol'; items: string[] }
  | { kind: 'paragraph'; text: string };
interface Statement { ids: string[]; rest: string }
interface Doc { path: string; slug: string; blocks: Block[]; title: string; translated: boolean }

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAll = (text: string): string => escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const plain = (text: string): string => text.replace(/[`*]/g, '').replace(/\s*\[(?:observed|assumed)[^\]]*\]/g, '').trim();
const blank = (line: string): boolean => line.trim() === '';
// A line that ends a list or a paragraph: blank, or one that starts a code block, a table or a heading.
const ends = (line: string): boolean => blank(line) || line.startsWith(FENCE) || line.startsWith('|') || line.startsWith('#');
const slugOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.md'.length);

// A text's blocks, read line by line; every "starts with" looks at the raw line.
function blocksOf(text: string): Block[] {
  const lines = text.replaceAll('\0', '').split('\n');
  const blocks: Block[] = [];
  let at = 0;
  const take = (until: (line: string) => boolean): string[] => {
    const taken: string[] = [];
    for (let line = lines[at]; line !== undefined && !until(line); line = lines[++at]) {
      taken.push(line);
    }
    return taken;
  };
  while (at < lines.length) {
    const line = lines[at] ?? '';
    at += 1;
    if (blank(line)) {
      continue;
    }
    if (line.startsWith(FENCE)) {
      blocks.push({ kind: 'code', text: take((next) => next.startsWith(FENCE)).join('\n') });
      at += 1;
    } else if (HEADING.test(line)) {
      blocks.push({ kind: 'heading', level: line.length - line.replace(/^#+/, '').length, text: line.slice(line.indexOf(' ') + 1).trim() });
    } else if (line.startsWith('|')) {
      blocks.push({ kind: 'table', rows: [line, ...take((next) => !next.startsWith('|'))] });
    } else if (ITEM.test(line)) {
      const items = [line.replace(ITEM, '')];
      for (const next of take(ends)) {
        if (ITEM.test(next)) {
          items.push(next.replace(ITEM, ''));
        } else {
          items[items.length - 1] += ` ${next.trim()}`;
        }
      }
      blocks.push({ kind: 'list', tag: line.startsWith('- ') ? 'ul' : 'ol', items });
    } else {
      blocks.push({ kind: 'paragraph', text: [line, ...take((next) => ends(next) || ITEM.test(next))].map((part) => part.trim()).join(' ') });
    }
  }
  return blocks;
}

// A paragraph or list item whose text leads with a bold id, or ids joined by " = ".
function statementOf(text: string): Statement | undefined {
  const lead = LEAD.exec(text);
  const bold = lead?.[1]?.trim();
  if (lead === null || bold === undefined || !JOIN.test(bold)) {
    return undefined;
  }
  return { ids: bold.match(ID) ?? [], rest: text.slice(lead[0].length) };
}

// The paragraphs' and list items' texts of a document, from the top.
const proseOf = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.text] : block.kind === 'list' ? block.items : []));

// The documents of the English files: VISION.md, the chapters it names, the other chapters, CODEMAP.md.
function documentPaths(en: ReadonlyMap<string, string>, vision: string): string[] {
  const listed = [...new Set([...vision.matchAll(LISTED)].map((match) => match[1] ?? ''))].filter((path) => en.has(path));
  const others = [...en.keys()].filter((path) => CHAPTER.test(path) && !listed.includes(path)).sort();
  return ['VISION.md', ...listed, ...others, ...(en.has('CODEMAP.md') ? ['CODEMAP.md'] : [])];
}

// One language's block: its contents, its articles, and the place each id is defined.
function languageBlock(lang: VisionLanguage, docs: readonly Doc[], index: ReadonlyMap<string, string>): string {
  const ui = UI[lang];
  const other = VISION_LANGUAGES.find((language) => language !== lang) ?? lang;
  const slugs = new Set(docs.map((doc) => doc.slug));
  const anchored = new Set<string>();
  const link = (slug: string, text: string): string => `<a href="#${lang}~${slug}">${text}</a>`;
  const badge = (status: Status): string => `<span class="b ${status}">${ui[status]}</span>`;
  const muted = (marker: (typeof MARKERS)[number]): string => `<span class="b mu">${ui[marker]}</span>`;

  const codeSpan = (text: string): string => {
    if (text === '[observed]' || text === '[assumed]') {
      return badge(text === '[observed]' ? 'observed' : 'assumed');
    }
    const marker = MARKERS.find((name) => name === text);
    if (marker !== undefined) {
      return muted(marker);
    }
    const code = `<code>${escapeText(text)}</code>`;
    const slug = text.endsWith('.md') ? slugOf(text) : undefined;
    return slug !== undefined && slugs.has(slug) ? link(slug, code) : code;
  };

  const inline = (text: string): string => {
    const codes: string[] = [];
    let html = escapeText(text.replace(CODE, (_match, code: string) => `\0${codes.push(code) - 1}\0`));
    html = html.replace(BOLD, '<strong>$1</strong>').replace(ITALIC, '<em>$1</em>');
    html = html.replace(STATUS, (_match, status: Status, kind: string | undefined, rest: string | undefined) => {
      if (kind === ',') {
        return `${badge(status)} <span class="in">(${(rest ?? '').trim()})</span>`;
      }
      if (kind === ';') {
        const names = (rest ?? '').split(',').map((name) => name.trim()).map((name) => (slugs.has(name) ? link(name, name) : name));
        return `${badge(status)} <span class="in">${ui.in} ${names.join(', ')}</span>`;
      }
      return badge(status);
    });
    for (const marker of MARKERS) {
      html = html.replaceAll(marker, () => muted(marker));
    }
    html = html.split(TAG).map((part) => (part.startsWith('<') ? part : part
      .replace(ID, (id) => (index.has(id) ? `<a class="ref" href="#${lang}~${id}">${id}</a>` : id))
      .replace(MD_NAME, (match, name: string) => (slugs.has(name) ? link(name, `${name}.md`) : match)))).join('');
    return html.replace(MARK, (_match, number: string) => codeSpan(codes[Number(number)] ?? ''));
  };

  // A text cut at its evidence, which follows folded.
  const withEvidence = (text: string): string => {
    const cut = EVIDENCE.exec(text);
    if (cut === null) {
      return inline(text);
    }
    const evidence = text.slice(cut.index + cut[0].length);
    const count = evidence.match(LINE_REF)?.length ?? 0;
    return `${inline(text.slice(0, cut.index))}<details class="ev"><summary>${ui.evidence} · ${count}</summary><div>${inline(evidence)}</div></details>`;
  };

  // A paragraph's or list item's HTML: a statement's ids as chips, the first in its document an anchor.
  const prose = (text: string, slug: string): string => {
    const statement = statementOf(text);
    if (statement === undefined) {
      return withEvidence(text);
    }
    const chips = statement.ids.map((id) => {
      if (index.get(id) === slug && !anchored.has(id)) {
        anchored.add(id);
        return `<span class="id" id="${lang}~${id}">${id}</span>`;
      }
      return `<a class="id" href="#${lang}~${id}">${id}</a>`;
    });
    return `${chips.join(' ')} ${withEvidence(statement.rest)}`;
  };

  const documentHtml = (doc: Doc): string => {
    const bid = (number: number): string => `${lang}~${doc.slug}~${number}`;
    const sections = doc.blocks.flatMap((block, at) => (block.kind === 'heading' && block.level > 1 ? [{ text: block.text, id: bid(at + 1) }] : []));
    let led = false;
    return doc.blocks.map((block, at) => {
      const id = bid(at + 1);
      switch (block.kind) {
        case 'heading': {
          if (block.level > 1) {
            return `<h${block.level} id="${id}" class="s">${inline(block.text)}</h${block.level}>`;
          }
          let html = `<h1 id="${id}">${inline(block.text)}</h1>`;
          if (!led) {
            led = true;
            html += doc.translated ? '' : `<p class="note">${ui.untranslated}</p>`;
            html += sections.length > 2
              ? `<details class="toc" open><summary>${ui.here}</summary><ul>${sections.map((section) => `<li><a href="#${section.id}">${escapeAll(plain(section.text))}</a></li>`).join('')}</ul></details>`
              : '';
          }
          return html;
        }
        case 'code':
          return `<pre id="${id}">${escapeText(block.text)}</pre>`;
        case 'table': {
          const [head = [], , ...body] = block.rows.map((row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
          const cells = (row: string[], tag: string): string => row.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join('');
          return `<div class="tw" id="${id}"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body.map((row) => `<tr class="s">${cells(row, 'td')}</tr>`).join('')}</tbody></table></div>`;
        }
        case 'list':
          return `<${block.tag} id="${id}">${block.items.map((item, k) => `<li class="s" id="${id}~${k + 1}">${prose(item, doc.slug)}</li>`).join('')}</${block.tag}>`;
        case 'paragraph':
          return statementOf(block.text) === undefined
            ? `<p id="${id}" class="s">${prose(block.text, doc.slug)}</p>`
            : `<div id="${id}" class="s st">${prose(block.text, doc.slug)}</div>`;
      }
    }).join('');
  };

  const shorts = docs.map((doc) => doc.title.split(':')[0]?.trim() ?? '');
  const short = docs.map((doc, at) => escapeAll(shorts.filter((name) => name === shorts[at]).length > 1 ? doc.title : shorts[at] ?? ''));
  const navLink = (doc: Doc, at: number): string => `<a class="d" href="#${lang}~${doc.slug}" title="${escapeAll(doc.title)}">${short[at]}</a>`;
  // VISION.md first; then the chapters; then the other documents (CODEMAP.md).
  const [vision = '', ...more] = docs.map(navLink);
  const chapters = more.filter((_, at) => CHAPTER.test(docs[at + 1]?.path ?? ''));
  const others = more.filter((_, at) => !CHAPTER.test(docs[at + 1]?.path ?? ''));
  const links = vision
    + (chapters.length > 0 ? `<div class="g">${ui.chapters}</div>${chapters.join('')}` : '')
    + (others.length > 0 ? `<div class="g"></div>${others.join('')}` : '');
  const neighbour = (at: number, text: (name: string) => string): string => {
    const doc = docs[at];
    return doc === undefined ? '<span></span>' : link(doc.slug, text(short[at] ?? ''));
  };
  const articles = docs.map((doc, at) => {
    const before = neighbour(at - 1, (name) => `← ${name}`);
    const after = neighbour(at + 1, (name) => `${name} →`);
    return `<article class="doc" id="${lang}~${doc.slug}" data-title="${short[at]}">${documentHtml(doc)}<footer class="pn">${before}${after}</footer></article>`;
  }).join('');

  return `<div class="lang" id="${lang}" lang="${lang}">
<input type="checkbox" class="navt" id="N-${lang}" aria-label="${ui.contents}">
<header class="bar"><label for="N-${lang}" class="btn nb">☰</label><button class="btn back" hidden title="${ui.back}">←</button>
<span class="cur">${ui.title}</span><button class="btn qb" hidden title="${ui.search}">⌕</button><input type="search" class="q" placeholder="${ui.search}" hidden>
<span class="sw"><label for="L-${lang}" class="on">${ui.name}</label><label for="L-${other}">${UI[other].name}</label></span></header>
<nav><div class="navh">${ui.contents}</div>${links}<p class="legend">${ui.legend}</p></nav>
<label for="N-${lang}" class="shade"></label>
<main><div class="res" hidden data-none="${ui.none}" data-more="${ui.more}"></div>${articles}</main></div>`;
}

// The page: one HTML document that loads nothing from outside itself.
export function visionPage(files: VisionFiles): string {
  const vision = files.en.get('VISION.md')?.replaceAll('\0', '');
  if (vision === undefined) {
    throw new Error('visionPage: the English files have no VISION.md.');
  }
  const paths = documentPaths(files.en, vision);
  const english = paths.map((path) => ({ path, slug: slugOf(path), blocks: blocksOf(files.en.get(path) ?? '') }));
  const index = new Map<string, string>();
  for (const doc of english) {
    for (const text of proseOf(doc.blocks)) {
      for (const id of statementOf(text)?.ids ?? []) {
        if (!index.has(id)) {
          index.set(id, doc.slug);
        }
      }
    }
  }
  const docsIn = (lang: VisionLanguage): Doc[] => english.map((doc) => {
    const translation = lang === 'bg' ? files.bg?.get(doc.path) : undefined;
    const blocks = translation === undefined ? doc.blocks : blocksOf(translation);
    const heading = blocks.filter((block) => block.kind === 'heading' && block.level === 1).at(-1);
    const title = heading?.kind === 'heading' ? plain(heading.text) : doc.slug;
    return { ...doc, blocks, title, translated: lang === 'en' || translation !== undefined };
  });
  const docs = { bg: docsIn('bg'), en: docsIn('en') };
  const title = docs.bg[0]?.title || docs.en[0]?.title || 'Vision';
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAll(title)}</title><style>${VISION_PAGE_STYLE}</style></head><body>
<input type="radio" name="L" id="L-bg" class="lr" checked><input type="radio" name="L" id="L-en" class="lr">
${VISION_LANGUAGES.map((lang) => languageBlock(lang, docs[lang], index)).join('')}<script>${VISION_PAGE_SCRIPT}</script></body></html>`;
}
