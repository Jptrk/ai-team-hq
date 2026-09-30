/**
 * UI helpers: markdown previews, hash routes, board filter, top-bar search, report links.
 * Run: npm run test:ui. Pure functions, no browser, no network.
 */
import assert from 'node:assert/strict';
import type { Agent, WorkItem } from '../shared/types';
import { EMPTY_FILTER, filterItems, isFiltered } from './components/board/filter';
import { searchItems } from './lib/search';
import { plainText } from './markdown/plainText';
import { isReportUrl, reportFileName, resolveReportHref } from './markdown/reportLinks';
import { parseRoute, projectPath } from './route';
import { readableInk } from './util';

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

console.log(`ui: ${passed} tests passed`);
