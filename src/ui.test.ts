/**
 * UI helpers: markdown previews, hash routes, board filter, top-bar search, report links, editor markdown.
 * Run: npm run test:ui. Pure functions and a headless editor, no browser, no network.
 */
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { titleFrom } from '../shared/plainText';
import { canEditDescription, type Agent, type WorkItem } from '../shared/types';
import { EMPTY_FILTER, filterItems, isFiltered } from './components/board/filter';
import { searchItems } from './lib/search';
import { plainText } from './markdown/plainText';
import { installTypedTextEscaping } from './editor/markdownEscape';
import { fitWithin, imageFiles } from './lib/images';
import { cleanMarkdown, escapeTypedText, looksLikeDiffOrTerminal, looksLikeMarkdown, needsPlainEditor } from './lib/markdownPaste';
import { attachmentUrl, isAttachmentUrl, isReportUrl, reportFileName, resolveReportHref } from './markdown/reportLinks';
import { parseRoute, projectPath } from './route';
import { latestDecision, readableInk } from './util';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const item = (n: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id: `w${n}`,
  number: n,
  kind: 'fyi',
  title: `Ticket ${n}`,
  summary: '',
  status: 'todo',
  from: 'you',
  assignee: 'leo',
  dated: '2026-10-01',
  links: [],
  history: [],
  ...extra,
});

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  role: 'role',
  desk: 'desk',
  status: 'idle',
  color: '#3d7a3a',
  seat: { col: 0, row: 0 },
  lastActive: '2026-10-01T00:00:00Z',
  skills: [],
});

// ---------- plainText ----------
test('plainText strips emphasis, links, code and headings', () => {
  const md = '## Top PRs\n\n**Bold** and _em_ with `code` and [a link](https://x.y).';
  assert.equal(plainText(md), 'Top PRs Bold and em with code and a link.');
});
test('plainText flattens tables without pipes', () => {
  const md = '| PR | Author |\n|---|---|\n| #12 | Ana |';
  const out = plainText(md);
  assert.ok(!out.includes('|'), out);
  assert.ok(!out.includes('---'), out);
  assert.ok(out.includes('PR') && out.includes('Ana'), out);
  assert.equal(plainText('Test\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Test · a · b · 1 · 2');
});
test('plainText drops lists, quotes, task boxes and html', () => {
  const md = '> quoted\n- [x] done task\n- item\n1. first\n<img src=x onerror=alert(1)>';
  const out = plainText(md);
  assert.equal(out, 'quoted done task item first');
});
test('plainText has no ** left and truncates on a word', () => {
  const out = plainText('**' + 'word '.repeat(60) + '**', 40);
  assert.ok(!out.includes('**'), out);
  assert.ok(out.endsWith('…'), out);
  assert.ok(out.length <= 41, String(out.length));
});
test('plainText removes code blocks', () => {
  assert.equal(plainText('Before\n```ts\nconst a = 1;\n```\nAfter'), 'Before After');
});
test('plainText reads older escaped text as typed', () => {
  assert.equal(plainText('Fix Q&amp;A for &lt;Header&gt; in C:\\\\repo\\\\src\\_x\\\\a\\_b.ts'), 'Fix Q&A for <Header> in C:\\repo\\src_x\\a_b.ts');
  assert.equal(plainText('\\*not italic\\* and \\_\\_init\\_\\_ and \\[x\\](y)'), '*not italic* and __init__ and [x](y)');
  assert.equal(plainText('a&nbsp;b &quot;q&quot; it&#39;s'), 'a b "q" it\'s');
  assert.equal(plainText('\\# not a heading'), '# not a heading');
  assert.equal(plainText('&amp;lt; stays one level'), '&lt; stays one level');
});
test('titleFrom: first line with words, code blocks skipped', () => {
  assert.equal(titleFrom('```\nnpm test\n```\nFix the **header**', 0, 80), 'Fix the header');
  assert.equal(titleFrom('---\n\n## Plan\nmore', 0, 80), 'Plan');
  assert.equal(titleFrom('Look\n```\nnever closed', 0, 80), 'Look');
  assert.equal(titleFrom('', 1, 80), 'Look at the attached image');
  assert.equal(titleFrom('```\nonly code\n```', 2, 80), 'Look at the attached images');
  assert.equal(titleFrom('```\nonly code\n```', 0, 80), 'New task');
  assert.ok(titleFrom('word '.repeat(40), 0, 80).length <= 81);
});
test('titleFrom: threads take all the text', () => {
  assert.equal(titleFrom('Hey @Leo\nwho owns checkout?', 0, 60, 'thread'), 'Hey @Leo who owns checkout?');
  assert.equal(titleFrom('', 1, 60, 'thread'), 'Image from you');
  assert.equal(titleFrom('```\nx\n```', 0, 60, 'thread'), 'New thread');
});

// ---------- routes ----------
test('parseRoute: home, projects, new', () => {
  assert.deepEqual(parseRoute(''), { kind: 'home' });
  assert.deepEqual(parseRoute('#/projects'), { kind: 'projects' });
  assert.deepEqual(parseRoute('#/projects/new'), { kind: 'new' });
});
test('parseRoute: project views default to needs-you', () => {
  assert.deepEqual(parseRoute('#/p/gecom-apps'), { kind: 'project', pid: 'gecom-apps', view: 'needs-you', threadId: undefined, ticket: undefined, agent: undefined });
  assert.equal((parseRoute('#/p/x/board') as { view: string }).view, 'board');
  assert.equal((parseRoute('#/p/x/nonsense') as { view: string }).view, 'needs-you');
});
test('parseRoute: thread, ticket and agent', () => {
  const r = parseRoute('#/p/x/chat/t_1?ticket=GA-12');
  assert.equal(r.kind, 'project');
  if (r.kind !== 'project') return;
  assert.equal(r.view, 'chat');
  assert.equal(r.threadId, 't_1');
  assert.equal(r.ticket, 'GA-12');
  const a = parseRoute('#/p/x/team?agent=leo');
  assert.ok(a.kind === 'project' && a.agent === 'leo' && a.ticket === undefined);
  const both = parseRoute('#/p/x/board?ticket=GA-1&agent=leo');
  assert.ok(both.kind === 'project' && both.ticket === 'GA-1' && both.agent === undefined, 'ticket wins over agent');
});
test('parseRoute: settings and connections', () => {
  assert.deepEqual(parseRoute('#/p/x/settings'), { kind: 'settings', pid: 'x' });
  assert.deepEqual(parseRoute('#/p/x/connections'), { kind: 'connections', pid: 'x' });
});
test('parseRoute: bad percent-encoding does not throw', () => {
  const r = parseRoute('#/p/%E0%A4%A/board');
  assert.equal(r.kind, 'project');
});
test('projectPath builds paths that parse back', () => {
  assert.equal(projectPath('gecom-apps'), '/p/gecom-apps');
  assert.equal(projectPath('g', 'board', { ticket: 'GA-3' }), '/p/g/board?ticket=GA-3');
  assert.equal(projectPath('g', 'chat', { threadId: 't 1' }), '/p/g/chat/t%201');
  assert.equal(projectPath('g', 'board', { threadId: 'ignored' }), '/p/g/board');
  for (const p of [projectPath('g', 'chat', { threadId: 't/1', agent: 'leo' }), projectPath('g', 'office', { ticket: 'GA-9' })]) {
    const back = parseRoute(`#${p}`);
    assert.equal(back.kind, 'project');
  }
  const round = parseRoute(`#${projectPath('g', 'chat', { threadId: 't/1' })}`);
  assert.ok(round.kind === 'project' && round.threadId === 't/1');
});

// ---------- board filter ----------
const items = [
  item(1, { title: 'Fix checkout', status: 'needs-you', client: 'Acme' }),
  item(2, { title: 'Write report', assignee: 'grace', summary: 'Top **PRs** this week' }),
  item(3, { title: 'Deploy', status: 'held', assignee: 'grace' }),
  item(4, { title: 'Done thing', status: 'done' }),
];
test('filterItems: empty filter keeps all', () => {
  assert.equal(isFiltered(EMPTY_FILTER), false);
  assert.equal(filterItems(items, EMPTY_FILTER, 'GA').length, 4);
});
test('filterItems: text matches key, title, client and summary', () => {
  assert.deepEqual(filterItems(items, { ...EMPTY_FILTER, text: 'ga-2' }, 'GA').map((i) => i.id), ['w2']);
  assert.deepEqual(filterItems(items, { ...EMPTY_FILTER, text: 'acme' }, 'GA').map((i) => i.id), ['w1']);
  assert.deepEqual(filterItems(items, { ...EMPTY_FILTER, text: 'prs' }, 'GA').map((i) => i.id), ['w2']);
  assert.equal(isFiltered({ ...EMPTY_FILTER, text: '  ' }), false);
});
test('filterItems: assignee and needs-me combine', () => {
  assert.deepEqual(filterItems(items, { ...EMPTY_FILTER, assignees: ['grace'] }, 'GA').map((i) => i.id), ['w2', 'w3']);
  assert.deepEqual(filterItems(items, { ...EMPTY_FILTER, needsMe: true }, 'GA').map((i) => i.id), ['w1', 'w3']);
  assert.deepEqual(filterItems(items, { text: '', assignees: ['grace'], needsMe: true }, 'GA').map((i) => i.id), ['w3']);
});

// ---------- search ----------
const agents = [agent('leo', 'Leo'), agent('grace', 'Grace')];
test('searchItems: exact key ranks first', () => {
  const many = [...items, item(12, { title: 'GA-1 mentioned in title' })];
  const hits = searchItems(many, 'GA-1', 'GA', agents);
  assert.equal(hits[0].key, 'GA-1');
});
test('searchItems: title, owner and empty query', () => {
  assert.equal(searchItems(items, 'deploy', 'GA', agents)[0].key, 'GA-3');
  assert.deepEqual(searchItems(items, 'grace', 'GA', agents).map((h) => h.key).sort(), ['GA-2', 'GA-3']);
  assert.deepEqual(searchItems(items, '   ', 'GA', agents), []);
  assert.equal(searchItems(items, 'ga-', 'GA', agents, 2).length, 2);
});

// ---------- report links ----------
const base = '/api/projects/gecom-apps/workspaces/grace/report?file=reports%2Fopen-prs-top5.md';
test('isReportUrl and reportFileName', () => {
  assert.ok(isReportUrl(base));
  assert.ok(!isReportUrl('https://github.com/x'));
  assert.equal(reportFileName(base), 'open-prs-top5.md');
});
test('resolveReportHref: sibling, nested and parent', () => {
  assert.equal(resolveReportHref(base, 'plan.md'), '/api/projects/gecom-apps/workspaces/grace/report?file=reports%2Fplan.md');
  assert.equal(resolveReportHref(base, './sub/x.md'), '/api/projects/gecom-apps/workspaces/grace/report?file=reports%2Fsub%2Fx.md');
  assert.equal(resolveReportHref(base, '../notes.md'), '/api/projects/gecom-apps/workspaces/grace/report?file=notes.md');
  assert.equal(resolveReportHref(base, 'plan.md#part'), '/api/projects/gecom-apps/workspaces/grace/report?file=reports%2Fplan.md');
});
test('resolveReportHref: refuses anything that is not another report', () => {
  assert.equal(resolveReportHref(base, '../../../secret.md'), null);
  assert.equal(resolveReportHref(base, '#section'), null);
  assert.equal(resolveReportHref(base, 'https://github.com/a.md'), null);
  assert.equal(resolveReportHref(base, 'javascript:alert(1)'), null);
  assert.equal(resolveReportHref(base, '/etc/passwd.md'), null);
  assert.equal(resolveReportHref(base, 'image.png'), null);
  assert.equal(resolveReportHref(base, base), base);
});

// ---------- colors ----------
test('readableInk picks legible initials', () => {
  assert.equal(readableInk('#b4482f'), '#ffffff');
  assert.equal(readableInk('#e0a83a'), '#1f2018');
  assert.equal(readableInk('#f2d24b'), '#1f2018');
  assert.equal(readableInk('var(--x)'), '#ffffff');
});
test('readableInk reaches 4.5:1 on every color', () => {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  let worst = 99;
  for (let r = 0; r < 256; r += 17)
    for (let g = 0; g < 256; g += 17)
      for (let b = 0; b < 256; b += 17) {
        const bg = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        const a = lum(bg);
        const i = lum(readableInk(bg));
        worst = Math.min(worst, (Math.max(a, i) + 0.05) / (Math.min(a, i) + 0.05));
      }
  assert.ok(worst >= 4.5, `worst contrast ${worst.toFixed(2)}`);
});

// ---------- images ----------
test('fitWithin scales the long side to 1568 and never up', () => {
  assert.deepEqual(fitWithin(3136, 1000), { w: 1568, h: 500, scaled: true });
  assert.deepEqual(fitWithin(1000, 4000), { w: 392, h: 1568, scaled: true });
  assert.deepEqual(fitWithin(800, 600), { w: 800, h: 600, scaled: false });
  assert.deepEqual(fitWithin(1568, 1568), { w: 1568, h: 1568, scaled: false });
  assert.equal(fitWithin(20000, 1).h, 1, 'never rounds to zero');
});
test('imageFiles keeps only the four image types', () => {
  const f = (name: string, type: string) => new File(['x'], name, { type });
  const picked = imageFiles([f('a.png', 'image/png'), f('b.svg', 'image/svg+xml'), f('c.jpg', 'image/jpeg'), f('d.pdf', 'application/pdf'), f('e.webp', 'image/webp'), f('g.gif', 'image/gif')]);
  assert.deepEqual(picked.map((x) => x.name), ['a.png', 'c.jpg', 'e.webp', 'g.gif']);
  assert.deepEqual(imageFiles(null), []);
});
test('attachment URLs: only HQ image paths count', () => {
  const url = attachmentUrl('gecom-apps', 'att_0123456789ab.png');
  assert.equal(url, '/api/projects/gecom-apps/attachments/att_0123456789ab.png');
  assert.ok(isAttachmentUrl(url));
  for (const bad of ['https://evil.example/att_0123456789ab.png', '/api/projects/x/attachments/att_0123456789ab.svg', '/api/projects/x/attachments/../db.json', '/api/projects/x/attachments/att_0123456789ab.png?x=1', 'javascript:alert(1)', '//evil/api/projects/x/attachments/att_0123456789ab.png']) {
    assert.ok(!isAttachmentUrl(bad), bad);
  }
});
test('latestDecision finds the newest decision comment', () => {
  const it = item(40, { comments: [
    { id: 'c1', from: 'leo', ts: '1', text: 'old ask', kind: 'decision', title: 'A' },
    { id: 'c2', from: 'you', ts: '2', text: 'hm' },
    { id: 'c3', from: 'leo', ts: '3', text: 'new ask', kind: 'decision', title: 'B' },
    { id: 'c4', from: 'leo', ts: '4', text: 'fyi' },
  ] });
  assert.equal(latestDecision(it)?.title, 'B');
  assert.equal(latestDecision(item(41)), undefined);
});

// ---------- editor ----------
test('looksLikeMarkdown: markdown pastes format, plain text stays plain', () => {
  for (const md of ['# Title', '## Plan\nDo it', '- one\n- two', '1. first\n2. second', '> quoted', '```ts\nx\n```', '| a | b |\n|---|---|\n| 1 | 2 |', '---', '- [ ] task', 'This is **bold** text', 'an _italic_ word', 'use `npm test`', 'see [docs](https://x.y/z)', '~~old~~ new']) {
    assert.ok(looksLikeMarkdown(md), md);
  }
  for (const plain of ['', '   ', 'Just a sentence.', 'Price is 5 * 3 = 15', 'snake_case_name and other_name', 'https://example.com/a_b_c', 'C:\\Users\\patri\\file.txt', 'email me at a@b.co', '2 - 1 = 1', 'x*y*z']) {
    assert.ok(!looksLikeMarkdown(plain), plain);
  }
});
test('cleanMarkdown trims trailing blanks and treats an empty box as empty', () => {
  assert.equal(cleanMarkdown(''), '');
  assert.equal(cleanMarkdown('\n\n'), '');
  assert.equal(cleanMarkdown('&nbsp;'), '');
  assert.equal(cleanMarkdown('&nbsp;\n\n&nbsp;'), '');
  assert.equal(cleanMarkdown('**hi**\n\n'), '**hi**');
  assert.equal(cleanMarkdown('line one\n\nline two  \n'), 'line one\n\nline two');
  assert.equal(cleanMarkdown('# Plan\n\n- first\n- second\n- \n\n'), '# Plan\n\n- first\n- second');
  assert.equal(cleanMarkdown('1. one\n2. \n'), '1. one');
  assert.equal(cleanMarkdown('> quote\n> \n'), '> quote');
  assert.equal(cleanMarkdown('a - b'), 'a - b', 'a dash inside a line stays');
});
test('cleanMarkdown drops empty paragraphs and empty last tasks', () => {
  assert.equal(cleanMarkdown('a\n\n&nbsp;\n\nb'), 'a\n\nb');
  assert.equal(cleanMarkdown('a\n\n\u00a0\n\n&nbsp;\n\n\n\nb'), 'a\n\nb');
  assert.equal(cleanMarkdown('&nbsp;\n\n\n\nHello'), 'Hello', 'leading empty paragraphs go');
  assert.equal(cleanMarkdown('\n| a | b |\n| --- | --- |\n'), '| a | b |\n| --- | --- |');
  assert.equal(cleanMarkdown('\n\nx\n\n\n\n- [ ] '), 'x', 'what the editor saves for empty lines and a fresh task');
  assert.equal(cleanMarkdown('- [ ] one\n- [ ] '), '- [ ] one');
  assert.equal(cleanMarkdown('- [x] done\n- [x]'), '- [x] done');
  assert.equal(cleanMarkdown('```\n&nbsp;\n\n\n```'), '```\n&nbsp;\n\n\n```', 'code keeps its lines');
  assert.equal(cleanMarkdown('a&nbsp;b'), 'a&nbsp;b', 'an &nbsp; inside a line stays');
});
test('escapeTypedText escapes only what would format', () => {
  const same = ['5 * 3', 'foo_bar', 'src_x', 'a_b.ts', '~5 min', 'a ~ b', '[x] alone', 'C:\\repo\\src', 'Q&A <Header>', '@QA_Bot', 'C:\\repo\\src_x\\a_b.ts'];
  for (const t of same) assert.equal(escapeTypedText(t), t, t);
  assert.equal(escapeTypedText('a*b*c'), 'a\\*b\\*c');
  assert.equal(escapeTypedText('*star*'), '\\*star\\*');
  assert.equal(escapeTypedText('__init__'), '\\_\\_init\\_\\_');
  assert.equal(escapeTypedText('_word_'), '\\_word\\_');
  assert.equal(escapeTypedText('~~old~~'), '\\~\\~old\\~\\~');
  assert.equal(escapeTypedText('use `npm`'), 'use \\`npm\\`');
  assert.equal(escapeTypedText('[x](y)'), '\\[x\\](y)');
  assert.equal(escapeTypedText('[a][b] and [c]'), '\\[a\\]\\[b\\] and \\[c\\]');
});
test('looksLikeDiffOrTerminal: diffs, terminal output and stack traces', () => {
  for (const code of [
    'diff --git a/x.ts b/x.ts\nindex 1a2b..3c4d 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new',
    '-old line\n+new line',
    '\n> ai-team-hq@0.1.0 test:ui\n> tsx src/ui.test.ts\n\nui: 30 tests passed',
    '> @scope/pkg@1.2.3 build',
    '$ npm test\n\nok',
    'PS C:\\Users\\patri> npm test',
    'TypeError: x is undefined\n    at foo (src/a.ts:10:5)\n    at bar (src/b.ts:2:1)',
    'Traceback (most recent call last):\n  File "a.py", line 1, in <module>',
  ]) {
    assert.ok(looksLikeDiffOrTerminal(code), code);
  }
  for (const text of ['', '- one\n- two', '- one\n  - nested', '1. first\n2. second', '> quoted text', '+1 for this', 'Costs $5 total', 'Just a sentence.', 'see at the docs (page 2)']) {
    assert.ok(!looksLikeDiffOrTerminal(text), text);
  }
});
test('needsPlainEditor: images, HTML and footnotes', () => {
  for (const md of ['![shot](/a.png)', 'a <b>bold</b> word', 'line<br>break', 'note[^1]', '<details>\n<summary>x</summary>']) assert.ok(needsPlainEditor(md), md);
  for (const md of ['**bold** and [a link](https://x.y)', 'a < b and c > d', '5<6', '- [ ] task']) assert.ok(!needsPlainEditor(md), md);
});

// ---------- editor markdown, with the real extensions and no browser ----------
installTypedTextEscaping();
const extensions = () => [
  StarterKit.configure({ underline: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
];
const paragraphs = (...texts: string[]) => ({ type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
test('the editor saves typed text as typed', () => {
  const typed = 'Fix Q&A for <Header> in C:\\repo\\src_x\\a_b.ts and foo_bar';
  const ed = new Editor({ element: null, extensions: extensions(), content: paragraphs(typed) });
  try {
    assert.equal(ed.getMarkdown(), typed);
    ed.commands.setContent(ed.getMarkdown(), { contentType: 'markdown' });
    assert.equal(ed.getText(), typed, 'reads back as the same text');
    // Escaped where it has to be, so it reads back as text and not formatting.
    for (const text of ['*not italic* and 5 * 3', '__init__ and foo_bar', '~~not struck~~ in ~5 min', '[not](a link) and [x]', 'use `npm` here']) {
      ed.commands.setContent(paragraphs(text));
      ed.commands.setContent(ed.getMarkdown(), { contentType: 'markdown' });
      assert.equal(ed.getText(), text, text);
    }
  } finally {
    ed.destroy();
  }
});
test('the editor keeps formatting: saves, reads back, saves the same', () => {
  const ed = new Editor({ element: null, extensions: extensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } });
  const round = (md: string) => {
    ed.commands.setContent(md, { contentType: 'markdown' });
    return cleanMarkdown(ed.getMarkdown());
  };
  try {
    assert.equal(round('**bold** and *it* and `a_b * c` and [link](https://x.y/z) and ~~old~~'), '**bold** and *it* and `a_b * c` and [link](https://x.y/z) and ~~old~~');
    assert.equal(round('- one\n- two\n  - nested\n\n1. a\n2. b'), '- one\n- two\n  - nested\n\n1. a\n2. b');
    assert.equal(round('- [ ] todo\n- [x] done'), '- [ ] todo\n- [x] done');
    for (const md of ['| a | b |\n| --- | --- |\n| 1 | C:\\x |', '```ts\nconst a_b = `x` * 2;\n```', '> quote with C:\\x and a_b', '# Plan\n\nShip **it** & tell <Team>']) {
      const once = round(md);
      assert.equal(round(once), once, md);
    }
    assert.equal(round('```ts\nconst a_b = `x` * 2;\n```'), '```ts\nconst a_b = `x` * 2;\n```', 'code is never escaped');
  } finally {
    ed.destroy();
  }
});
test('descriptions are editable only in To do', () => {
  assert.equal(canEditDescription('todo'), true);
  for (const s of ['in-progress', 'needs-you', 'approved', 'held', 'sent-back', 'done'] as const) assert.equal(canEditDescription(s), false, s);
});

console.log(`ui: ${passed} tests passed`);
