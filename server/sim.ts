import type { WorkItem } from '../shared/types';
import { leadOf, refreshStatuses, settleInstructions } from './agents';
import { clearWaiting, markRead, messagesOf, postAgentMessage, threadForItem } from './chat';
import { addComment } from './comments';
import { allProjects, now, today, uid, type Project } from './store';

/**
 * Simulated agent activity so the dashboard feels alive without a real runner.
 * Only runs in sim mode. Disable with SIMULATE=0.
 */

const TICK_MS = 9_000;

const FOLLOW_UPS: Record<string, { title: string; summary: string; kind: WorkItem['kind'] }[]> = {
  paige: [
    { kind: 'decide', title: 'Reply to Toi: new time for Tue check-in', summary: 'Toi asked to move the Tuesday check-in. Proposed 3 PM ET, calendar is clear. Approve to send.' },
    { kind: 'decide', title: 'Confirm dentist reschedule to Thursday 9 AM', summary: 'The clinic offered Thursday 9 AM. Nothing conflicts. Approve to confirm.' },
  ],
  mike: [
    { kind: 'review', title: 'Proposal draft for Harbor & Co', summary: 'Scope and pricing drafted from the discovery call notes. Review before it goes to the client.' },
    { kind: 'fyi', title: '3 deals flagged as stale', summary: 'No activity in 14 days: Alder Labs, Pinecrest, Volta. Suggest a re-engagement sequence.' },
  ],
  riley: [{ kind: 'review', title: 'First-touch messages for top 10 prospects', summary: 'Ten personalized openers ready. Review the tone before I send.' }],
  maria: [{ kind: 'decide', title: 'Refund request from an academy member', summary: 'A member asked for a refund 9 days after purchase. Policy says 7. Your call.' }],
  denzel: [{ kind: 'review', title: 'Lead-alert webhook rebuilt', summary: 'New leads now post to Slack within 10 seconds. Review the message format.' }],
  shakira: [{ kind: 'review', title: 'Thumbnail v1 for module 1', summary: 'First thumbnail in the academy style. Approve the direction and I will do the other five.' }],
  dylan: [{ kind: 'fyi', title: 'Daily standup summary', summary: 'All desks reported. Two items need you, everything else is on track.' }],
  nora: [{ kind: 'review', title: 'Sprint plan for next week', summary: 'Broke the open requests into 9 tickets with estimates. Review the order before I hand them out.' }],
  leo: [{ kind: 'review', title: 'Checkout page layout fix', summary: 'Proposed patch for the mobile checkout overflow. Diff is in the report.' }],
  sam: [{ kind: 'decide', title: 'Add an index on orders.customer_id?', summary: 'The order history query scans the table. An index cuts it from 900ms to 12ms. Approve the migration plan?' }],
  ivy: [{ kind: 'fyi', title: 'Regression run: 2 flaky tests', summary: 'Two cart tests fail intermittently on a timing issue. Details and repro in the report.' }],
  omar: [{ kind: 'review', title: 'Dockerfile slimmed down', summary: 'Multi-stage build drops the image from 1.4 GB to 380 MB. Review before I open a PR.' }],
  grace: [{ kind: 'review', title: 'Security review of the PayPal endpoint', summary: 'Two findings: missing idempotency key and a verbose error message. Fix plan in the report.' }],
  theo: [{ kind: 'review', title: 'README refresh', summary: 'Rewrote setup steps for the monorepo. Review the new quick start.' }],
};

/** Background work each desk picks up on its own when its queue is empty. */
const ROUTINES: Record<string, string[]> = {
  dylan: ['Checking every desk for blockers', 'Rebalancing the week against your calendar', 'Writing the standup summary'],
  paige: ['Clearing the inbox and drafting replies', 'Compiling the EOD report', 'Confirming tomorrow’s meetings'],
  mike: ['Following up on stale deals', 'Updating next steps on open deals', 'Prepping call notes for tomorrow'],
  riley: ['Scoring new LinkedIn connections', 'Drafting first-touch messages', 'Checking replies to last week’s outreach'],
  maria: ['Answering community DMs', 'Tagging warm inbound leads for Mike', 'Scheduling this week’s posts'],
  denzel: ['Monitoring automations for failures', 'Cleaning up webhook logs', 'Testing the lead-alert flow'],
  shakira: ['Drafting next week’s thumbnails', 'Refreshing the carousel template', 'Exporting assets to the shared folder'],
  rodrigo: ['Reconciling timesheets', 'Reviewing the contractor agreements', 'Updating the policy handbook'],
  nora: ['Grooming the backlog', 'Reading through last week’s merged changes', 'Updating the architecture notes'],
  leo: ['Auditing components for accessibility', 'Cleaning up unused styles', 'Checking bundle size'],
  sam: ['Reviewing slow API endpoints', 'Tidying database migrations', 'Checking error logs'],
  ivy: ['Running the regression suite', 'Triaging new bug reports', 'Writing missing unit tests'],
  omar: ['Watching the CI pipeline', 'Checking dependency updates', 'Reviewing infra costs'],
  grace: ['Reviewing open pull requests', 'Scanning for outdated packages', 'Checking lint warnings'],
  theo: ['Updating the changelog', 'Fixing stale README sections', 'Documenting new endpoints'],
};

function pick<T>(arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

// ---------- sim chat: canned replies so the Chat tab works without spending usage ----------

const QUESTIONS = [
  'Quick one: is {topic} on your side, or should I take it?',
  'Can you check {topic} before I raise this for Patrick?',
  'Do you have anything on {topic} yet? I am blocked on it.',
];
const ANSWERS = [
  'Yes, {topic} is mine. I can pick it up after my current ticket.',
  'Checked. Nothing changes on my side; go ahead.',
  'Not my desk. {lead} has the context on that.',
  'I have a draft already. It is in my reports folder.',
  'Two things: it depends on the release date, and I need the final copy first.',
];
const CLOSERS = ['Noted. Updating the ticket.', 'Clear, moving on with it.', 'Got what I need.'];

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? k);

function tickChat(p: Project): void {
  const s = p.state;
  const lead = leadOf(s.agents);

  // Desks woken in a thread answer, one per thread per tick, like someone typing.
  for (const t of s.threads) {
    if (t.status === 'closed' || t.waiting.length === 0) continue;
    const who = t.waiting[0];
    const agent = s.agents.find((a) => a.id === who && !a.isHuman);
    clearWaiting(t, who);
    if (!agent || agent.status === 'off') continue;
    const asked = [...messagesOf(s, t.id)].reverse().find((m) => m.to.includes(who));
    markRead(t, who);
    if (!asked) continue;
    const deskTurns = messagesOf(s, t.id).filter((m) => m.from !== 'you' && m.from !== 'hq').length;
    const vars = { topic: agent.role.toLowerCase(), lead: lead?.name ?? 'the lead' };
    try {
      if (asked.from === 'you') postAgentMessage(s, t, who, ['you'], fill(pick(ANSWERS) ?? 'On it.', vars));
      else if (deskTurns < 3) postAgentMessage(s, t, who, [asked.from], fill(pick(ANSWERS) ?? 'On it.', vars));
      else postAgentMessage(s, t, who, [], pick(CLOSERS) ?? 'Noted.');
    } catch {
      /* thread closed meanwhile */
    }
    agent.lastActive = now();
  }

  // Now and then a desk asks a teammate about one of its tickets.
  if (Math.random() < 0.08) {
    const busy = s.items.filter((i) => i.status === 'in-progress' && s.agents.some((a) => a.id === i.assignee && !a.isHuman && a.status !== 'off'));
    const item = pick(busy);
    if (item) {
      const from = s.agents.find((a) => a.id === item.assignee)!;
      const to = pick(s.agents.filter((a) => !a.isHuman && a.id !== from.id && a.status !== 'off'));
      if (to) {
        const t = threadForItem(s, item, p.ticket(item), from.id);
        if (t.status === 'open') {
          postAgentMessage(s, t, from.id, [to.id], fill(pick(QUESTIONS) ?? 'Quick question.', { topic: item.title.toLowerCase().slice(0, 50) }));
          p.log(from.id, `Messaged ${to.name} about ${p.ticket(item)}`);
        }
      }
    }
  }
}

/** General answers: none of them mention images. The "(looked at your image)" suffix is added only when there are some. */
const COMMENT_REPLIES = [
  'Got it. I will fold that into the next pass.',
  'Seen. That changes the order, so I am starting with your point first.',
  'Thanks, that is clear. I will adjust the plan to match.',
  'Understood. I will comment here again when it is ready for you.',
];

/** Your plain comments get an answer from the ticket's desk, one tick later. Instruct and Send back notes do not. */
function tickComments(p: Project): void {
  for (const item of p.state.items) {
    const last = item.comments?.at(-1);
    if (!last || last.from !== 'you' || (last.kind && last.kind !== 'comment')) continue;
    const agent = p.state.agents.find((a) => a.id === item.assignee && !a.isHuman);
    if (!agent || agent.status === 'off') continue;
    const seen = last.attachments?.length ? ` (looked at your ${last.attachments.length === 1 ? 'image' : `${last.attachments.length} images`})` : '';
    addComment(item, { from: agent.id, text: `${pick(COMMENT_REPLIES) ?? 'Noted.'}${seen}` });
    agent.lastActive = now();
    p.log(agent.id, `Commented on ${p.ticket(item)} "${item.title}"`);
  }
}

function tickProject(p: Project): void {
  const s = p.state;
  tickComments(p);

  // Idle desks pick up routine work so the office never goes quiet.
  for (const agent of s.agents) {
    if (agent.isHuman || agent.status === 'off') continue;
    const busy = s.items.some((i) => i.assignee === agent.id && (i.status === 'in-progress' || i.status === 'sent-back' || i.status === 'todo'));
    if (busy || Math.random() > 0.6) continue;
    const title = pick(ROUTINES[agent.id] ?? []);
    if (!title) continue;
    s.items.unshift({
      id: uid('wi'),
      number: p.nextNumber(),
      kind: 'fyi',
      status: 'in-progress',
      title,
      summary: `${agent.name} picked this up between assignments.`,
      client: 'Routine',
      from: agent.id,
      assignee: agent.id,
      dated: today(),
      links: [],
      history: [{ ts: now(), text: 'Started' }],
    });
    agent.currentTask = title;
    agent.lastActive = now();
    p.log(agent.id, `Started "${title}"`);
  }

  // Approved work gets carried out and finishes, the way a live desk reports it done.
  for (const done of s.items.filter((i) => i.status === 'approved' && Math.random() < 0.4)) {
    done.status = 'done';
    done.history.push({ ts: now(), text: 'Done: carried out what you approved' });
    p.log(done.assignee, `Finished "${done.title}"`);
  }

  const active = s.items.filter((i) => i.status === 'in-progress' || i.status === 'sent-back');

  // Occasionally start a queued item.
  if (Math.random() < 0.35) {
    const next = s.items.find((i) => i.status === 'todo' && s.agents.find((a) => a.id === i.assignee)?.status !== 'off');
    if (next) {
      next.status = 'in-progress';
      next.history.push({ ts: now(), text: 'Started' });
      const agent = s.agents.find((a) => a.id === next.assignee);
      if (agent) {
        agent.currentTask = next.title;
        agent.lastActive = now();
      }
      p.log(next.assignee, `Started "${next.title}"`);
    }
  }

  // Progress one active item: either finish it, or raise something for the owner.
  const item = pick(active);
  if (item) {
    const agent = s.agents.find((a) => a.id === item.assignee);
    const roll = Math.random();
    if (roll < 0.25) {
      item.status = 'done';
      item.history.push({ ts: now(), text: 'Finished' });
      p.log(item.assignee, `Finished "${item.title}"`);
      if (agent) {
        agent.currentTask = 'Wrapping up and looking for the next task';
        agent.lastActive = now();
      }
    } else if (roll < 0.45) {
      const follow = pick(FOLLOW_UPS[item.assignee] ?? []);
      const alreadyOpen = s.items.some((i) => i.status === 'needs-you' && i.title === follow?.title);
      if (follow && !alreadyOpen) {
        s.items.unshift({
          id: uid('wi'),
          number: p.nextNumber(),
          kind: follow.kind,
          status: follow.kind === 'fyi' ? 'done' : 'needs-you',
          title: follow.title,
          summary: follow.summary,
          client: item.client,
          from: item.assignee,
          assignee: item.assignee,
          dated: today(),
          links: [{ label: 'Read the full report', url: '#' }],
          history: [{ ts: now(), text: `Raised while working on "${item.title}"` }],
        });
        p.log(item.assignee, follow.kind === 'fyi' ? follow.title : `Needs you: ${follow.title}`);
        if (agent) agent.lastActive = now();
      }
    } else if (agent) {
      agent.lastActive = now();
    }
  }

  tickChat(p);
  settleInstructions(s);
  refreshStatuses(s);
  p.commit();
}

export function startSim(): () => void {
  const handle = setInterval(() => {
    for (const p of allProjects()) tickProject(p);
  }, TICK_MS);
  return () => clearInterval(handle);
}
