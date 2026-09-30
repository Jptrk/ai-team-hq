import type { Agent, State, TeamTemplate, WorkItem } from '../shared/types';
import { MAX_TEAM } from '../shared/types';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const AGENT_COLORS = ['#3b6ea5', '#8a5fb8', '#2f8f6b', '#d98a2b', '#c9407a', '#4f8fd6', '#e0a83a', '#6b7f3a', '#b4482f', '#5a8f8f', '#9b6b43'];

/** Office seats: a 4x3 grid. The founder sits top-right. */
const SEAT_ORDER: { col: number; row: number }[] = [];
for (const row of [1, 2, 0]) for (const col of [3, 2, 1, 0]) SEAT_ORDER.push({ col, row });

/** Give every agent a free seat, keeping seats they already have. */
export function assignSeats(agents: Agent[]): void {
  const taken = new Set<string>();
  const key = (s: { col: number; row: number }) => `${s.col},${s.row}`;
  for (const a of agents) {
    if (a.seat && !taken.has(key(a.seat))) taken.add(key(a.seat));
    else a.seat = { col: -1, row: -1 };
  }
  for (const a of agents) {
    if (a.seat.col >= 0) continue;
    const free = SEAT_ORDER.find((s) => !taken.has(key(s)));
    if (!free) break;
    a.seat = { ...free };
    taken.add(key(free));
  }
}

function founder(name: string): Agent {
  return {
    id: 'you', name, role: 'Founder', desk: 'Corner office', status: 'working', isHuman: true,
    color: '#c2452d', seat: { col: 3, row: 0 }, lastActive: ago(1), skills: [],
  };
}

type Desk = Omit<Agent, 'status' | 'lastActive' | 'seat' | 'color'> & { color?: string; seat?: Agent['seat']; status?: Agent['status'] };

function desks(list: Desk[]): Agent[] {
  return list.map((d, i) => ({
    status: 'idle',
    lastActive: ago(5),
    seat: d.seat ?? { col: -1, row: -1 },
    color: d.color ?? AGENT_COLORS[i % AGENT_COLORS.length],
    currentTask: 'Waiting for the first instruction',
    ...d,
  }));
}

function businessTeam(): Agent[] {
  return desks([
    { id: 'dylan', name: 'Dylan', role: 'COO', desk: 'Ops desk', lead: true, color: '#3b6ea5', seat: { col: 3, row: 1 },
      skills: ['routing', 'planning', 'standup', 'priorities', 'plan', 'organize'] },
    { id: 'paige', name: 'Paige', role: 'Report Desk + EA', desk: 'Report desk', color: '#8a5fb8', seat: { col: 2, row: 1 },
      skills: ['email', 'reply', 'calendar', 'report', 'schedule', 'meeting', 'invite', 'summary', 'eod'] },
    { id: 'mike', name: 'Mike', role: 'Pipeline Desk', desk: 'Pipeline desk', color: '#2f8f6b', seat: { col: 1, row: 1 },
      skills: ['crm', 'pipeline', 'deal', 'lead', 'follow-up', 'followup', 'proposal', 'quote', 'sales'] },
    { id: 'riley', name: 'Riley', role: 'Social Prospecting', desk: 'Prospecting desk', color: '#d98a2b', seat: { col: 0, row: 1 },
      skills: ['linkedin', 'prospect', 'outreach', 'dm', 'connection', 'icp', 'cold'] },
    { id: 'maria', name: 'Maria', role: 'Social + Inbound', desk: 'Inbound desk', color: '#c9407a', seat: { col: 0, row: 2 },
      skills: ['inbound', 'academy', 'comment', 'community', 'post', 'content', 'caption', 'social'] },
    { id: 'denzel', name: 'Denzel', role: 'Automation Builder', desk: 'Build desk', color: '#4f8fd6', seat: { col: 1, row: 2 },
      skills: ['automation', 'workflow', 'zap', 'webhook', 'integration', 'build', 'api', 'script', 'app', 'tool'] },
    { id: 'shakira', name: 'Shakira', role: 'Designer', desk: 'Design desk', color: '#e0a83a', seat: { col: 2, row: 2 },
      skills: ['design', 'carousel', 'thumbnail', 'logo', 'brand', 'canva', 'graphic', 'slide'] },
    { id: 'rodrigo', name: 'Rodrigo', role: 'HR + Compliance', desk: 'People desk', color: '#6b7f3a', seat: { col: 2, row: 0 },
      status: 'off', currentTask: 'Off shift until 8:00 AM',
      skills: ['hr', 'compliance', 'payroll', 'timesheet', 'contract', 'policy', 'onboarding', 'hire'] },
  ]);
}

function devTeam(): Agent[] {
  return desks([
    { id: 'nora', name: 'Nora', role: 'Tech Lead', desk: 'Lead desk', lead: true, color: '#3b6ea5',
      skills: ['plan', 'planning', 'architecture', 'spec', 'estimate', 'roadmap', 'breakdown', 'priorities', 'design-doc', 'investigate', 'explain'] },
    { id: 'leo', name: 'Leo', role: 'Frontend Engineer', desk: 'Frontend desk', color: '#c9407a',
      skills: ['frontend', 'ui', 'ux', 'react', 'next', 'nextjs', 'css', 'component', 'page', 'layout', 'html', 'styling', 'accessibility', 'a11y', 'checkout'] },
    { id: 'sam', name: 'Sam', role: 'Backend Engineer', desk: 'Backend desk', color: '#2f8f6b',
      skills: ['backend', 'api', 'endpoint', 'database', 'db', 'sql', 'schema', 'service', 'server', 'migration', 'auth', 'graphql', 'paypal', 'payment', 'webhook'] },
    { id: 'ivy', name: 'Ivy', role: 'QA Engineer', desk: 'QA desk', color: '#d98a2b',
      skills: ['test', 'tests', 'testing', 'qa', 'bug', 'bugs', 'regression', 'e2e', 'unit', 'coverage', 'repro', 'reproduce', 'playwright', 'jest'] },
    { id: 'omar', name: 'Omar', role: 'DevOps Engineer', desk: 'Ops desk', color: '#4f8fd6',
      skills: ['deploy', 'deployment', 'ci', 'cd', 'pipeline', 'docker', 'dockerfile', 'build', 'infra', 'terraform', 'vercel', 'kubernetes', 'env', 'config', 'turbo'] },
    { id: 'grace', name: 'Grace', role: 'Code Reviewer', desk: 'Review desk', color: '#8a5fb8',
      skills: ['review', 'pr', 'security', 'refactor', 'lint', 'audit', 'quality', 'vulnerability', 'owasp', 'zap', 'cleanup'] },
    { id: 'theo', name: 'Theo', role: 'Docs Writer', desk: 'Docs desk', color: '#6b7f3a',
      skills: ['docs', 'documentation', 'readme', 'changelog', 'guide', 'onboarding', 'write-up', 'runbook', 'document'] },
  ]);
}

function blankTeam(): Agent[] {
  return desks([
    { id: 'alex', name: 'Alex', role: 'Generalist', desk: 'Main desk', lead: true, color: '#3b6ea5', skills: [] },
  ]);
}

const TEAMS: Record<TeamTemplate, () => Agent[]> = { business: businessTeam, dev: devTeam, blank: blankTeam };

function businessDemo(): WorkItem[] {
  return [
    {
      id: 'wi_1', kind: 'decide', status: 'needs-you', from: 'paige', assignee: 'paige',
      client: 'New Identity Marketing', dated: day(-1),
      title: 'Reply to Paul: signed agreement received, day-one setup',
      summary:
        'Paul countersigned the retainer at 6:13 PM ET. Draft reply confirms receipt, proposes Tuesday 12 PM ET for the kickoff, and lists the three access items we need from his team (GA4, Meta Business, brand folder). Nothing goes out until you approve.',
      links: [{ label: 'Read the full report', url: '#' }, { label: 'Open the draft', url: '#' }],
      history: [{ ts: ago(50), text: 'Paige drafted the reply and flagged it for decision' }],
    },
    {
      id: 'wi_2', kind: 'decide', status: 'needs-you', from: 'paige', assignee: 'paige',
      client: 'Personal brand', dated: day(-1),
      title: 'Reply to Vicki: confirm Tue 12 PM ET podcast + Zoom link',
      summary: 'Vicki asked to lock the podcast recording for Tuesday. Calendar shows the slot is free. Draft reply confirms and attaches the Zoom link. Approve to send.',
      links: [{ label: 'Read the full report', url: '#' }],
      history: [{ ts: ago(80), text: 'Paige checked the calendar and drafted a confirmation' }],
    },
    {
      id: 'wi_3', kind: 'decide', status: 'needs-you', from: 'paige', assignee: 'paige',
      client: 'Academy', dated: day(-3),
      title: 'Reply to May: program details, post-call follow-up, needs current price',
      summary: "May wants the program outline and pricing after yesterday's call. The outline is ready. Pricing sheet in the vault is from July, so I need you to confirm the current price before this goes out.",
      links: [{ label: 'Read the full report', url: '#' }],
      history: [{ ts: ago(200), text: 'Paige drafted the follow-up, blocked on pricing' }],
    },
    {
      id: 'wi_4', kind: 'review', status: 'needs-you', from: 'denzel', assignee: 'denzel',
      client: 'Internal', dated: day(-1),
      title: 'Onboarding workflow rebuild: review before I switch it on',
      summary: 'Rebuilt the new-client onboarding automation: intake form to CRM contact to welcome email to Slack alert. Tested with three dummy contacts, all passed. Wants sign-off before enabling on production.',
      links: [{ label: 'View the test log', url: '#' }],
      history: [{ ts: ago(30), text: 'Denzel finished testing and requested review' }],
    },
    {
      id: 'wi_5', kind: 'review', status: 'needs-you', from: 'shakira', assignee: 'shakira',
      client: 'Personal brand', dated: day(-2),
      title: 'Carousel drafts for next week: pick a direction',
      summary: 'Two directions for the "5 mistakes" carousel: bold typographic vs. illustrated. Both are in the shared folder. Pick one and I will finish the remaining slides.',
      links: [{ label: 'Open the drafts', url: '#' }],
      history: [{ ts: ago(120), text: 'Shakira uploaded two draft directions' }],
    },
    {
      id: 'wi_6', kind: 'fyi', status: 'in-progress', from: 'mike', assignee: 'mike', client: 'Pipeline', dated: day(0),
      title: 'Weekly pipeline clean-up',
      summary: 'Moving stale deals, updating next steps, and flagging anything with no activity in 14 days.',
      links: [], history: [{ ts: ago(10), text: 'Mike started the clean-up' }],
    },
    {
      id: 'wi_7', kind: 'fyi', status: 'in-progress', from: 'riley', assignee: 'riley', client: 'Prospecting', dated: day(0),
      title: 'Qualify new LinkedIn connections',
      summary: "Scoring this week's 40 new connections against the ICP and drafting first-touch messages for the top 10.",
      links: [], history: [{ ts: ago(15), text: 'Riley started scoring' }],
    },
    {
      id: 'wi_8', kind: 'fyi', status: 'in-progress', from: 'maria', assignee: 'maria', client: 'Academy', dated: day(0),
      title: 'Inbound DM triage',
      summary: 'Answering overnight DMs and tagging warm leads for Mike.',
      links: [], history: [{ ts: ago(20), text: 'Maria started triage' }],
    },
    {
      id: 'wi_9', kind: 'fyi', status: 'todo', from: 'dylan', assignee: 'rodrigo', client: 'Internal', dated: day(0),
      title: 'September timesheet reconciliation',
      summary: 'Compare logged hours against the EOD reports and flag any gaps.',
      links: [], history: [],
    },
    {
      id: 'wi_10', kind: 'fyi', status: 'todo', from: 'dylan', assignee: 'shakira', client: 'Academy', dated: day(1),
      title: 'Thumbnail set for October modules',
      summary: 'Six thumbnails in the academy style, one per module.',
      links: [], history: [],
    },
    {
      id: 'wi_11', kind: 'fyi', status: 'done', from: 'paige', assignee: 'paige', client: 'Internal', dated: day(-1),
      title: 'Daily EOD report compiled',
      summary: "Compiled yesterday's end-of-day notes from all desks into a single report.",
      links: [{ label: 'Read the report', url: '#' }],
      history: [{ ts: ago(600), text: 'Paige published the report' }],
    },
    {
      id: 'wi_12', kind: 'fyi', status: 'done', from: 'mike', assignee: 'mike', client: 'Pipeline', dated: day(-2),
      title: 'Proposal sent to Northwind Studio',
      summary: 'Proposal delivered with the revised scope.',
      links: [], history: [{ ts: ago(2000), text: 'Mike sent the proposal' }],
    },
  ];
}

export interface SeedOptions {
  /** Team only, no demo work. */
  empty?: boolean;
  ownerName: string;
  projectName: string;
}

export function seed(template: TeamTemplate, opts: SeedOptions): State {
  const agents = [founder(opts.ownerName), ...TEAMS[template]()].slice(0, MAX_TEAM);
  assignSeats(agents);
  const lead = agents.find((a) => a.lead) ?? agents.find((a) => !a.isHuman);

  const demo = template === 'business' && !opts.empty;
  const items = demo ? businessDemo() : [];
  let seq = 0;
  for (const item of [...items].reverse()) item.number = ++seq;

  if (demo) {
    const working: Record<string, { status: Agent['status']; task: string }> = {
      dylan: { status: 'working', task: "Routing this morning's instructions and checking the daily standup notes" },
      paige: { status: 'waiting', task: 'Drafting replies to client emails from overnight' },
      mike: { status: 'working', task: 'Updating CRM stages for 14 open deals' },
      riley: { status: 'working', task: 'Qualifying 40 new LinkedIn connections against the ICP' },
      maria: { status: 'working', task: 'Answering DMs and tagging inbound leads for the academy' },
      denzel: { status: 'waiting', task: 'Waiting for approval on the onboarding workflow rebuild' },
      shakira: { status: 'waiting', task: 'Waiting for feedback on the carousel drafts' },
    };
    for (const a of agents) {
      const w = working[a.id];
      if (w) {
        a.status = w.status;
        a.currentTask = w.task;
      }
    }
  }

  return {
    company: { name: opts.projectName, ownerId: 'you', timezone: 'America/New_York' },
    agents,
    items,
    instructions: [],
    runs: [],
    seq,
    connections: [],
    checks: {},
    threads: [],
    messages: [],
    chat: { day: new Date().toISOString().slice(0, 10), wakes: 0 },
    activity: demo
      ? [
          { id: 'act_1', ts: ago(2), agentId: 'dylan', text: 'Reviewed overnight queue, nothing urgent before your first meeting' },
          { id: 'act_2', ts: ago(4), agentId: 'paige', text: 'Drafted 3 client replies, all waiting on you' },
          { id: 'act_3', ts: ago(6), agentId: 'mike', text: 'Moved 2 deals to "Proposal sent"' },
          { id: 'act_4', ts: ago(30), agentId: 'denzel', text: 'Onboarding workflow passed all 3 test runs' },
        ]
      : [{ id: 'act_1', ts: ago(0), agentId: lead?.id ?? 'you', text: 'Team is online. Send an instruction to get started.' }],
  };
}
