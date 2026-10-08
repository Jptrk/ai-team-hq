/**
 * UI helpers: markdown previews, hash routes, board columns and filter, top-bar search, report links, what waits on you, editor markdown, add connection, skills links.
 * Run: npm run test:ui. Pure functions and a headless editor, no browser, no network.
 */
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { titleFrom } from '../shared/plainText';
import { parseReportUrl, reportTitleFrom } from '../shared/reportUrl';
import { BOARD_COLUMNS, boardColumns, canEditDescription, type Agent, type Comment, type WorkItem } from '../shared/types';
import { EMPTY_FILTER, filterItems, isFiltered } from './components/board/filter';
import { searchItems } from './lib/search';
import { plainText } from './markdown/plainText';
import { installTypedTextEscaping } from './editor/markdownEscape';
import { fitWithin, imageFiles } from './lib/images';
import { cleanMarkdown, escapeTypedText, looksLikeDiffOrTerminal, looksLikeMarkdown, needsPlainEditor } from './lib/markdownPaste';
import { attachmentUrl, isAttachmentUrl, isReportUrl, reportFileName, resolveReportHref } from './markdown/reportLinks';
import { parseRoute, projectPath } from './route';
import { awaitsSignoff, clockTime, latestDecision, readableInk, autoTodayText, effortLabel, goalLabel, goLiveHint, holdText, pauseLabel, pauseText, runnerLabel, signoffVerdict, waitingSummary, waitingTitle } from './util';
import { MCP_PRESETS, presetArgs, presetDefaults } from '../shared/mcpPresets';
import { buildSpec, safeAuthUrl } from '../shared/mcpSpec';
import type { ConnectionRow, SkillMeta } from '../shared/types';
import { alreadySetUp, blankRow, CUSTOM, hostOf, initialForm, presetCards, signInButtons, splitArgs, timeLeft, toRequest } from './components/connections/addForm';
import { deskCoverage, folderUrl, groupByRepo, newFetchToken, openKeys, parseOpenGroups, pickedAtFirst, plural, repoParts, repoUrl, sizeLabel, sourceLabel, withOpen } from './components/skills/skillInfo';

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
test('parseRoute: home, projects, new, account', () => {
  assert.deepEqual(parseRoute(''), { kind: 'home' });
  assert.deepEqual(parseRoute('#/projects'), { kind: 'projects' });
  assert.deepEqual(parseRoute('#/projects/new'), { kind: 'new' });
  assert.deepEqual(parseRoute('#/account'), { kind: 'account' });
  assert.deepEqual(parseRoute('#/account/anything'), { kind: 'account' });
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
  assert.deepEqual(parseRoute('#/p/x/skills'), { kind: 'skills', pid: 'x' });
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
test('huddles and team notes: list, one huddle, a ticket over it, notes', () => {
  assert.equal(projectPath('g', 'huddles'), '/p/g/huddles');
  assert.equal(projectPath('g', 'huddles', { huddleId: 'hud_1', ticket: 'GA-2' }), '/p/g/huddles/hud_1?ticket=GA-2');
  assert.equal(projectPath('g', 'board', { huddleId: 'ignored' }), '/p/g/board');
  const one = parseRoute('#/p/g/huddles/hud_1?ticket=GA-2');
  assert.ok(one.kind === 'project' && one.view === 'huddles' && one.huddleId === 'hud_1' && one.ticket === 'GA-2');
  const list = parseRoute('#/p/g/huddles');
  assert.ok(list.kind === 'project' && list.view === 'huddles' && !('huddleId' in list));
  assert.ok(!('huddleId' in parseRoute('#/p/g/board/hud_1')), 'only the huddles view reads an id');
  assert.equal((parseRoute('#/p/g/notes') as { view: string }).view, 'notes');
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
test('parseReportUrl: project, desk and file; other query params ignored', () => {
  assert.deepEqual(parseReportUrl(base), { pid: 'gecom-apps', agent: 'grace', file: 'reports/open-prs-top5.md' });
  assert.deepEqual(parseReportUrl('/api/projects/my%20app/workspaces/leo/report?v=2&file=plan.md&x'), { pid: 'my app', agent: 'leo', file: 'plan.md' });
  assert.deepEqual(parseReportUrl('/api/projects/x/workspaces/leo_2/report?file=a%2Bb+c.md#top'), { pid: 'x', agent: 'leo_2', file: 'a+b c.md' });
});
test('parseReportUrl: bad %-encoding, odd desk names, a second file and lookalikes give null', () => {
  for (const bad of [
    '/api/projects/x/workspaces/leo/report?file=%E0%A4%A',
    '/api/projects/%E0%A4%A/workspaces/leo/report?file=a.md',
    '/api/projects/x/workspaces/le.o/report?file=a.md',
    '/api/projects/x/workspaces/le%20o/report?file=a.md',
    '/api/projects/x/workspaces/leo/report?file=a.md&file=b.md',
    '/api/projects/x/workspaces/leo/report?file=',
    '/api/projects/x/workspaces/leo/report',
    '/api/projects/x/workspaces/leo/reports?file=a.md',
    'https://evil.example/api/projects/x/workspaces/leo/report?file=a.md',
    '//evil/api/projects/x/workspaces/leo/report?file=a.md',
  ]) {
    assert.equal(parseReportUrl(bad), null, bad);
    assert.ok(!isReportUrl(bad), `the client agrees: ${bad}`);
  }
});
test('reportTitleFrom: first heading, code fences skipped, else the first line', () => {
  assert.equal(reportTitleFrom('```bash\n# install deps\nnpm i\n```\n\n## The plan\n'), 'The plan');
  assert.equal(reportTitleFrom('~~~\n# not this\n~~~\nIntro\n# Title'), 'Title');
  assert.equal(reportTitleFrom('#\n\nText'), 'Text');
  assert.equal(reportTitleFrom('#\n\nIntro\n\n## Real heading'), 'Real heading');
  assert.equal(reportTitleFrom('Just **notes** here\nmore'), 'Just notes here');
  assert.equal(reportTitleFrom('\r\n```\r\n# x\r\n```\r\n# Windows *lines*\r\n'), 'Windows lines');
  assert.equal(reportTitleFrom('Intro\n```\n# never closed'), 'Intro');
  assert.equal(reportTitleFrom('```\n# only code\n```'), null);
  assert.equal(reportTitleFrom(''), null);
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

test('waiting on you: a held sign-off shows the finished work and a sign-off title, not the original ask', () => {
  const asked: Comment = { id: 'c1', from: 'leo', ts: '1', text: 'Blue or green?', kind: 'decision', title: 'Pick a color' };
  const passed: Comment = { id: 'c2', from: 'ivy', ts: '2', text: 'Checked the handler.', kind: 'qa', title: 'Passed QA' };
  const history = [{ ts: '2026-10-01T00:00:00Z', text: 'Done: Wrote the landing copy' }];
  // Held in sign-off, nobody checked it: what the owner finished.
  const held = item(50, { status: 'held', summary: 'The ask', comments: [asked], history, qa: { fails: 0, ready: true, escalated: false } });
  assert.equal(awaitsSignoff(held), true);
  assert.equal(waitingTitle(held), 'On hold: finished, waiting for your sign-off');
  assert.equal(waitingSummary(held), 'Finished, waiting for your sign-off. Wrote the landing copy');
  // Held after QA passed it: QA's verdict.
  const checked = item(51, { status: 'held', comments: [asked, passed], history, qa: { fails: 0, by: 'ivy', result: 'pass', ready: true } });
  assert.equal(signoffVerdict(checked)?.title, 'Passed QA');
  assert.equal(waitingTitle(checked, 'Ivy'), 'On hold: finished, waiting for your sign-off');
  assert.equal(waitingSummary(checked), 'Passed QA. Checked the handler.');
  // In Sign-off, as before.
  const signoff = item(52, { status: 'signoff', comments: [passed], history, qa: { fails: 0, by: 'ivy', result: 'pass', ready: true } });
  assert.equal(waitingTitle(signoff, 'Ivy'), 'Passed QA (Ivy). Sign it off');
  const unchecked = item(53, { status: 'signoff', comments: [passed], history, qa: { fails: 0, ready: true } });
  assert.equal(signoffVerdict(unchecked), undefined, "an older round's pass never shows");
  assert.equal(waitingTitle(unchecked), 'Finished. Check it and sign it off');
  assert.equal(waitingSummary(unchecked), 'Finished. Check it and sign it off. Wrote the landing copy');
  // A held decision, or a held ticket QA gave up on: the desk's ask.
  const decision = item(54, { status: 'held', summary: 'The ask', comments: [asked] });
  assert.equal(awaitsSignoff(decision), false);
  assert.equal(waitingTitle(decision), 'On hold. Decide when ready');
  assert.equal(waitingSummary(decision), 'Pick a color. Blue or green?');
  const gaveUp = item(55, { status: 'held', comments: [asked], qa: { fails: 3, ready: true, escalated: true } });
  assert.equal(awaitsSignoff(gaveUp), false);
  assert.equal(waitingSummary(gaveUp), 'Pick a color. Blue or green?');
  assert.equal(waitingTitle(item(56, { status: 'needs-you', qa: { fails: 3, ready: true, escalated: true } })), 'Failed QA too often. Your call');
  assert.equal(waitingTitle(item(57, { status: 'needs-you' })), 'Needs your decision');
  assert.equal(waitingSummary(item(58, { status: 'needs-you', summary: 'Plain' })), 'Plain');
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
test('board: approved tickets stay In progress until the desk finishes them', () => {
  const columnOf = (status: WorkItem['status']) => BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.label;
  assert.equal(columnOf('approved'), 'In progress');
  assert.equal(columnOf('in-progress'), 'In progress');
  assert.equal(columnOf('sent-back'), 'In progress');
  assert.deepEqual(BOARD_COLUMNS.find((c) => c.label === 'Done')?.statuses, ['done']);
  const all = BOARD_COLUMNS.flatMap((c) => c.statuses);
  for (const s of ['todo', 'in-progress', 'needs-you', 'approved', 'held', 'sent-back', 'qa', 'signoff', 'done'] as const) assert.equal(all.filter((x) => x === s).length, 1, `${s} is in exactly one column`);
});
test('board columns: QA with QA on, Sign-off with sign-off on, and either while tickets sit in it', () => {
  const labels = (list: WorkItem[], on: { qa: boolean; signoff: boolean }) => boardColumns(list, on).map((c) => c.label);
  assert.deepEqual(labels([], { qa: true, signoff: true }), ['To do', 'In progress', 'QA', 'Sign-off', 'Needs you', 'Done']);
  assert.deepEqual(labels([], { qa: false, signoff: true }), ['To do', 'In progress', 'Sign-off', 'Needs you', 'Done']);
  assert.deepEqual(labels([], { qa: true, signoff: false }), ['To do', 'In progress', 'QA', 'Needs you', 'Done']);
  assert.deepEqual(labels([], { qa: false, signoff: false }), ['To do', 'In progress', 'Needs you', 'Done']);
  // Turned off with tickets still waiting: the column stays until they leave it.
  assert.deepEqual(labels([item(1, { status: 'signoff' })], { qa: false, signoff: false }), ['To do', 'In progress', 'Sign-off', 'Needs you', 'Done']);
  assert.deepEqual(labels([item(1, { status: 'qa' })], { qa: false, signoff: false }), ['To do', 'In progress', 'QA', 'Needs you', 'Done']);
  assert.deepEqual(boardColumns([], { qa: true, signoff: true }).find((c) => c.label === 'Sign-off')?.statuses, ['signoff'], 'a drop there moves it to sign-off');
});
test('board filter: tickets waiting for your sign-off count as Needs me', () => {
  const list = [item(1, { status: 'signoff' }), item(2, { status: 'qa' }), item(3, { status: 'in-progress' })];
  assert.deepEqual(filterItems(list, { ...EMPTY_FILTER, needsMe: true }, 'GA').map((i) => i.id), ['w1']);
});
test('descriptions are editable only in To do', () => {
  assert.equal(canEditDescription('todo'), true);
  for (const s of ['in-progress', 'needs-you', 'approved', 'held', 'sent-back', 'done'] as const) assert.equal(canEditDescription(s), false, s);
});

// ---------- add connection ----------

test('add connection: each preset form becomes a request the server accepts', () => {
  for (const p of MCP_PRESETS) {
    const f = initialForm(p.id, true);
    assert.equal(f.pick, p.id);
    assert.equal(f.scope, 'project');
    const built = buildSpec(toRequest(f));
    assert.ok(!('error' in built), p.id);
    if ('error' in built) continue;
    assert.equal(built.config.type, 'stdio');
    assert.deepEqual(built.config.type === 'stdio' && built.config.args, presetArgs(p, presetDefaults(p)));
  }
  // No folder: only "all my projects".
  assert.equal(initialForm('playwright', false).scope, 'all');
  assert.equal(initialForm('nope', true).pick, CUSTOM);
});
test('add connection: custom forms keep secrets out of the preview', () => {
  const f = { ...initialForm(CUSTOM, true), name: 'gh', transport: 'http' as const, url: ' https://api.example.com/mcp ', headers: [{ name: ' Authorization ', value: 'Bearer abc123', secret: true }, { name: '', value: '' }] };
  const req = toRequest(f);
  assert.equal(req.url, 'https://api.example.com/mcp');
  assert.deepEqual(req.headers, [{ name: 'Authorization', value: 'Bearer abc123', secret: true }]);
  const built = buildSpec(req);
  assert.ok(!('error' in built) && !built.preview.includes('abc123'));
  const cmd = toRequest({ ...initialForm(CUSTOM, true), name: 'x', transport: 'stdio', command: 'npx', argsText: '-y\n\n  some pkg  \r\n--flag', trust: true });
  assert.deepEqual(cmd.args, ['-y', 'some pkg', '--flag']);
  assert.equal(cmd.trustCommand, true);
  assert.deepEqual(splitArgs(''), []);
});
test('add connection: presets already set up say where', () => {
  const row = { name: 'chrome-devtools', source: 'user', present: true } as ConnectionRow;
  assert.equal(alreadySetUp([row], 'chrome-devtools'), 'Already set up (all projects)');
  assert.equal(alreadySetUp([{ ...row, present: false }], 'chrome-devtools'), null);
  assert.equal(presetCards([row]).find((c) => c.id === 'chrome-devtools')?.already, 'Already set up (all projects)');
  assert.equal(presetCards([row]).find((c) => c.id === 'playwright')?.already, null);
});
test('add connection: new rows start Secret, and a row named like a secret is masked even unticked', () => {
  assert.deepEqual(blankRow(), { name: '', value: '', secret: true });
  const f = {
    ...initialForm(CUSTOM, true),
    name: 'api',
    transport: 'http' as const,
    url: 'https://api.example.com/mcp',
    headers: [{ name: 'X-Mode', value: 'fast' }, { name: 'Authorization', value: 'Token abc123secret' }],
  };
  const built = buildSpec(toRequest(f));
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.ok(!built.preview.includes('abc123secret'), built.preview);
  assert.ok(built.preview.includes('header: X-Mode: fast'));
  assert.ok(built.secrets.includes('abc123secret'));
});
test('sign-in buttons: one way at a time, and the terminal command only for plain names', () => {
  const row = (extra: Partial<ConnectionRow>): ConnectionRow =>
    ({ name: 'sentry', source: 'folder', transport: 'http', target: 'https://mcp.sentry.dev/mcp', auth: 'oauth', present: true, connection: { name: 'sentry', source: 'folder', enabled: false, desks: [], mode: 'ask' }, check: { state: 'needs-login', checkedAt: '', tools: [] }, ...extra }) as ConnectionRow;
  assert.deepEqual(signInButtons(row({})), { login: true, logout: false, tryAgain: false, command: false });
  const failed = { state: 'failed' as const, error: 'x', expiresAt: '' };
  assert.deepEqual(signInButtons(row({ login: failed })), { login: false, logout: false, tryAgain: true, command: false });
  assert.deepEqual(signInButtons(row({ login: { ...failed, unsupported: true } })), { login: false, logout: false, tryAgain: false, command: true });
  assert.equal(signInButtons(row({ name: 'x;calc', login: { ...failed, unsupported: true } })).command, false);
  assert.equal(signInButtons(row({ name: 'my server', login: { ...failed, unsupported: true } })).command, false);
  assert.equal(signInButtons(row({ login: { state: 'waiting', expiresAt: '' } })).login, false);
  assert.equal(signInButtons(row({ check: { state: 'connected', checkedAt: '', tools: [] } })).logout, true);
  assert.equal(signInButtons(row({ target: 'http://127.0.0.1:3845/mcp', check: { state: 'connected', checkedAt: '', tools: [] } })).logout, false);
});
test('sign-in: only web links, with the host shown and time left', () => {
  assert.equal(safeAuthUrl('javascript:alert(1)'), null);
  assert.equal(safeAuthUrl('file:///C:/Windows'), null);
  assert.equal(hostOf('https://auth.example.com:8443/x'), 'auth.example.com:8443');
  assert.equal(hostOf('nope'), '');
  assert.equal(timeLeft(new Date(Date.UTC(2026, 0, 1, 0, 5, 30)).toISOString(), Date.UTC(2026, 0, 1, 0, 0, 0)), '5:30');
  assert.equal(timeLeft(new Date(0).toISOString(), 1000), '0:00');
});

// ---------- skills ----------
test('skills: sizes, counts and GitHub links, only for plain owner/repo names', () => {
  assert.equal(plural(1, 'script'), '1 script');
  assert.equal(plural(3, 'file'), '3 files');
  assert.equal(sizeLabel(900), '900 B');
  assert.equal(sizeLabel(48 * 1024), '48 KB');
  assert.equal(sizeLabel(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(repoUrl('o/r'), 'https://github.com/o/r');
  assert.equal(repoUrl('o/r/../x'), null);
  assert.equal(repoUrl('javascript:alert(1)//x/y'), null);
  const source = { repo: 'o/r', path: '.claude/skills/my skill', commit: 'abc123' };
  assert.equal(folderUrl(source), 'https://github.com/o/r/tree/abc123/.claude/skills/my%20skill');
  assert.equal(folderUrl({ repo: 'o/r', path: 'x', ref: 'main' }), 'https://github.com/o/r/tree/main/x');
  assert.equal(folderUrl({ repo: 'o/r', path: 'x' }), 'https://github.com/o/r/tree/HEAD/x');
  assert.equal(folderUrl({ repo: 'o/r', path: '' }), 'https://github.com/o/r');
  assert.equal(folderUrl({ repo: 'bad repo', path: '' }), null);
  assert.equal(sourceLabel(source), 'o/r/.claude/skills/my skill');
  assert.equal(sourceLabel({ repo: 'o/r', path: '' }), 'o/r');
});

test('skills: the install dialog ticks new skills and reinstalls, never copies, taken names or ones too big', () => {
  const base = { alreadyInstalled: false };
  assert.equal(pickedAtFirst(base), true);
  assert.equal(pickedAtFirst({ alreadyInstalled: true, replaces: 'x' }), true, 'a reinstall');
  assert.equal(pickedAtFirst({ alreadyInstalled: true }), false, 'the name is taken');
  assert.equal(pickedAtFirst({ ...base, duplicateOf: '.claude/skills/x' }), false, 'a copy');
  assert.equal(pickedAtFirst({ ...base, duplicateOf: '' }), false, "a copy of the repo's own root skill");
  assert.equal(pickedAtFirst({ ...base, problem: 'Too big' }), false);
  const a = newFetchToken();
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(newFetchToken(), a);
});

test('skills group by the repo they came from', () => {
  const skill = (id: string, name: string, repo: string) =>
    ({ id, name, description: '', source: { repo, path: `.claude/skills/${id}` }, installedAt: '', files: 1, bytes: 1, scripts: [], scriptsAllowed: false }) as SkillMeta;
  const groups = groupByRepo([
    skill('ui-ux-pro-max', 'ui-ux-pro-max', 'nextlevelbuilder/ui-ux-pro-max-skill'),
    skill('pdf', 'pdf', 'anthropics/skills'),
    skill('brand', 'brand', 'NextLevelBuilder/UI-UX-Pro-Max-Skill'),
    skill('docx', 'docx', 'anthropics/skills'),
  ]);
  // Groups by repo name (skills before ui-ux-pro-max-skill), case doesn't split a repo, skills by name inside.
  assert.deepEqual(
    groups.map((g) => [g.key, g.skills.map((s) => s.id)]),
    [
      ['anthropics/skills', ['docx', 'pdf']],
      ['nextlevelbuilder/ui-ux-pro-max-skill', ['brand', 'ui-ux-pro-max']],
    ],
  );
  assert.deepEqual(repoParts('nextlevelbuilder/ui-ux-pro-max-skill'), { owner: 'nextlevelbuilder', name: 'ui-ux-pro-max-skill' });
  assert.deepEqual(repoParts('loose'), { owner: '', name: 'loose' });
  assert.equal(groups[1].repo, 'nextlevelbuilder/ui-ux-pro-max-skill', 'keeps the casing it first saw');
});

test('skills on desks: all, some or none of these skills on these desks', () => {
  const map = { a: ['leo', 'sam'], b: ['leo'] };
  assert.equal(deskCoverage(['a'], map, ['leo', 'sam']), 'all');
  assert.equal(deskCoverage(['a', 'b'], map, ['leo']), 'all', 'one desk with both');
  assert.equal(deskCoverage(['a', 'b'], map, ['leo', 'sam']), 'some');
  assert.equal(deskCoverage(['b'], map, ['sam']), 'none');
  assert.equal(deskCoverage(['c'], map, ['leo']), 'none', 'a skill on no desk');
  assert.equal(deskCoverage([], map, ['leo']), 'none');
  assert.equal(deskCoverage(['a'], map, []), 'none', 'no desks to have it');
});

test('skill groups: which are open, saved per browser', () => {
  const keys = ['a/one', 'b/two'];
  // Nothing saved: a lone group opens, several start closed.
  assert.deepEqual([...openKeys(null, ['a/one'])], ['a/one']);
  assert.deepEqual([...openKeys(null, keys)], []);
  // Saved: only groups that still exist count.
  assert.deepEqual([...openKeys(new Set(['b/two', 'gone/repo']), keys)], ['b/two']);
  // Unreadable or odd values count as nothing saved.
  for (const raw of [null, '', 'not json', '{}', '"a/one"']) assert.equal(parseOpenGroups(raw), null, String(raw));
  assert.deepEqual([...parseOpenGroups('["a/one", 3]')!], ['a/one']);
  // The first toggle with nothing saved starts from what was showing: closing the lone open group.
  assert.deepEqual([...withOpen(null, ['a/one'], 'a/one', false)], []);
  // Opening after an install keeps the others as they were, and drops removed repos.
  assert.deepEqual([...withOpen(new Set(['a/one', 'gone/repo']), keys, 'b/two', true)].sort(), ['a/one', 'b/two']);
  // An install from a second repo starts from what was showing (the lone group, open by default), so it stays open.
  assert.deepEqual([...withOpen(openKeys(null, ['a/one']), keys, 'b/two', true)].sort(), ['a/one', 'b/two']);
});

test('header pill: sim, live with the models, and the effort only when set', () => {
  assert.equal(runnerLabel({ runner: 'sim', model: 'claude-opus-5', claudeReady: false }), 'Sim');
  assert.equal(runnerLabel({ runner: 'live', model: 'claude-opus-5', claudeReady: true }), 'Live · claude-opus-5');
  const gpt = { optedIn: true, ready: true, model: 'gpt-6.1-sol', effort: null };
  assert.equal(runnerLabel({ runner: 'live', model: 'claude-opus-5', claudeReady: true, gpt }), 'Live · claude-opus-5 + gpt-6.1-sol');
  // Claude projects wait (no Claude login, or one whose switch is off): the pill never names Claude's model.
  assert.equal(runnerLabel({ runner: 'live', model: 'claude-opus-5', claudeReady: false, gpt }), 'Live · gpt-6.1-sol', 'live on a ChatGPT login alone');
  assert.equal(runnerLabel({ runner: 'live', model: 'claude-opus-5', claudeReady: false, gpt: { ...gpt, model: null } }), 'Live · GPT', 'Codex default model');
  assert.equal(runnerLabel({ runner: 'live', model: 'claude-opus-5', claudeReady: true, gpt: { ...gpt, ready: false } }), 'Live · claude-opus-5', 'GPT not signed in');
  assert.equal(runnerLabel({ runner: 'live', model: 'claude-opus-5', claudeReady: false, gpt: { ...gpt, ready: false } }), 'Live', 'neither model can run');
  assert.equal(runnerLabel({ runner: 'sim', model: 'claude-opus-5', claudeReady: false, idle: true }), 'Not live');
  assert.equal(effortLabel({ runner: 'sim', effort: 'high' }), '');
  assert.equal(effortLabel({ runner: 'live', effort: null }), '');
  assert.equal(effortLabel({ runner: 'live', effort: 'xhigh' }), ' · extra high effort');
});

test('go live hint: the one step from sim, per state', () => {
  const base = { simByEnv: false, restartToGoLive: false, auth: 'none' as const, optedIn: false };
  assert.equal(goLiveHint({ ...base, simByEnv: true, auth: 'claude-login', optedIn: true }), 'HQ_RUNNER=sim in .env keeps HQ in sim.');
  assert.match(goLiveHint({ ...base, restartToGoLive: true, auth: 'claude-login', optedIn: true }), /restart HQ to go live/);
  assert.equal(goLiveHint({ ...base, auth: 'claude-login' }), 'Turn on Run desks on my Claude login to go live.');
  assert.equal(goLiveHint(base), 'Sign in with your Claude or ChatGPT account to go live.');
  assert.equal(goLiveHint({ ...base, optedIn: true }), 'Sign in with your Claude or ChatGPT account to go live.', 'a yes without a login still needs a sign-in');
});

test('pause and holds: what the header and a held ticket say', () => {
  assert.equal(pauseLabel({ by: 'you' }), 'Paused');
  assert.equal(pauseLabel({ by: 'account' }), 'Account problem');
  assert.equal(pauseLabel({ by: 'usage' }), 'Usage limit');
  // Today: just the time; another day (a weekly limit): the weekday too. Judged from now, whatever day the tests run.
  const soon = new Date(Date.now() + 60_000).toISOString();
  assert.match(pauseLabel({ by: 'usage', until: soon }), /^Usage limit · until (\d{2}:\d{2}|\S+ \d{2}:\d{2})$/);
  assert.match(clockTime('2026-10-06T07:00:00.000Z', Date.parse('2026-10-06T07:00:30.000Z')), /^\d{2}:\d{2}$/);
  assert.match(clockTime('2026-10-09T07:00:00.000Z', Date.parse('2026-10-06T07:00:00.000Z')), /^\S+ \d{2}:\d{2}$/);
  assert.match(pauseText({ by: 'you' }), /^The team starts nothing on its own/);
  assert.match(pauseText({ by: 'usage', reason: "Claude's 5-hour limit reached.", until: '2026-10-06T07:00:00.000Z' }), /^Claude's 5-hour limit reached\. .*carries on by itself at /);
  assert.match(pauseText({ by: 'account', reason: 'Claude reported a billing problem.' }), /until you resume\.$/);
  assert.equal(holdText({ reason: 'handoff', why: 'paused' }), 'The hand-off waits: HQ is paused. It starts by itself once that clears.');
  assert.equal(holdText({ reason: 'qa', why: 'usd' }), "The QA check waits: this project's spend for today is used up. It starts by itself once that clears.");
  // Neutral: the server's hold text in history and notes names the cause (switch off, or no login).
  assert.equal(holdText({ reason: 'handoff', why: 'model' }), "The hand-off waits: this project's model can't run yet. It starts by itself once that clears.");
  assert.equal(goalLabel({ status: 'on-track', planning: true }), 'Planning…');
  assert.equal(goalLabel({ status: 'reached', planning: false }), 'Reached?');
  assert.equal(goalLabel({ status: 'stalled', planning: false }), 'Stalled');
  assert.equal(autoTodayText({ runs: 6, maxRuns: 40, usd: 4.1, maxUsd: 25 }), 'Today 6/40 runs · $4.10 of $25');
  assert.equal(holdText({ reason: 'auto', why: 'restart' }), "Autopilot's start was cut off by a server restart. It starts again by itself.");
});

console.log(`ui: ${passed} tests passed`);
