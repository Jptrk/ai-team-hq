import type { WorkItem } from '../shared/types';
import { hasQa, projectProvider, signoffOn } from '../shared/types';
import { leadOf, refreshStatuses, settleInstructions } from './agents';
import { autoGate, countStart, globalHold, pickStarts } from './autopilot';
import { createGoalTicket, goalState, planDue, plannerOf, recordGoalStatus } from './goal';
import { clearWaiting, markRead, messagesOf, postAgentMessage, threadForItem } from './chat';
import { addComment } from './comments';
import { finishWork, qaDeskOf, recordQaResult, type QaVerdict } from './qa';
import { allProjects, now, today, uid, type Project } from './store';

/**
 * Simulated agent activity so the dashboard feels alive without a real runner.
 * Only runs in sim mode. Disable with SIMULATE=0.
 */

const TICK_MS = 9_000;

/** Keyed by role, not name: a new team's desks get fresh names (see DESK_NAMES in seed.ts). */
const FOLLOW_UPS: Record<string, { title: string; summary: string; kind: WorkItem['kind'] }[]> = {
  'Report Desk + EA': [
    { kind: 'decide', title: 'Reply to Toi: new time for Tue check-in', summary: 'Toi asked to move the Tuesday check-in. Proposed 3 PM ET, calendar is clear. Approve to send.' },
    { kind: 'decide', title: 'Confirm dentist reschedule to Thursday 9 AM', summary: 'The clinic offered Thursday 9 AM. Nothing conflicts. Approve to confirm.' },
  ],
  'Pipeline Desk': [
    { kind: 'review', title: 'Proposal draft for Harbor & Co', summary: 'Scope and pricing drafted from the discovery call notes. Review before it goes to the client.' },
    { kind: 'fyi', title: '3 deals flagged as stale', summary: 'No activity in 14 days: Alder Labs, Pinecrest, Volta. Suggest a re-engagement sequence.' },
  ],
  'Social Prospecting': [{ kind: 'review', title: 'First-touch messages for top 10 prospects', summary: 'Ten personalized openers ready. Review the tone before I send.' }],
  'Social + Inbound': [{ kind: 'decide', title: 'Refund request from an academy member', summary: 'A member asked for a refund 9 days after purchase. Policy says 7. Your call.' }],
  'Automation Builder': [{ kind: 'review', title: 'Lead-alert webhook rebuilt', summary: 'New leads now post to Slack within 10 seconds. Review the message format.' }],
  Designer: [{ kind: 'review', title: 'Thumbnail v1 for module 1', summary: 'First thumbnail in the academy style. Approve the direction and I will do the other five.' }],
  COO: [{ kind: 'fyi', title: 'Daily standup summary', summary: 'All desks reported. Two items need you, everything else is on track.' }],
  'Tech Lead': [{ kind: 'review', title: 'Sprint plan for next week', summary: 'Broke the open requests into 9 tickets with estimates. Review the order before I hand them out.' }],
  'Frontend Engineer': [{ kind: 'review', title: 'Checkout page layout fix', summary: 'Proposed patch for the mobile checkout overflow. Diff is in the report.' }],
  'Backend Engineer': [{ kind: 'decide', title: 'Add an index on orders.customer_id?', summary: 'The order history query scans the table. An index cuts it from 900ms to 12ms. Approve the migration plan?' }],
  'QA Engineer': [{ kind: 'fyi', title: 'Regression run: 2 flaky tests', summary: 'Two cart tests fail intermittently on a timing issue. Details and repro in the report.' }],
  'DevOps Engineer': [{ kind: 'review', title: 'Dockerfile slimmed down', summary: 'Multi-stage build drops the image from 1.4 GB to 380 MB. Review before I open a PR.' }],
  'Code Reviewer': [{ kind: 'review', title: 'Security review of the PayPal endpoint', summary: 'Two findings: missing idempotency key and a verbose error message. Fix plan in the report.' }],
  'Docs Writer': [{ kind: 'review', title: 'README refresh', summary: 'Rewrote setup steps for the monorepo. Review the new quick start.' }],
  'Design Lead': [{ kind: 'review', title: 'Critique notes on the onboarding flow', summary: 'Ran a critique with the product and UI desks. Three changes proposed, ranked by impact. Review the order before we start.' }],
  'Product Designer': [{ kind: 'review', title: 'Wireframes for the new settings flow', summary: 'Two flows: one long page vs. grouped tabs. Click-through prototype for both in the report. Pick one.' }],
  'UI Designer': [{ kind: 'review', title: 'High-fidelity mockups for the pricing page', summary: 'Desktop and mobile done in the current type scale. One open question on the plan comparison table.' }],
  'Brand Designer': [{ kind: 'decide', title: 'Two logo directions: pick one', summary: 'A wordmark and a monogram, both shown on the app icon, the site header and a business card. Your call.' }],
  'UX Researcher': [{ kind: 'fyi', title: 'Usability round 1: 5 sessions summarized', summary: '4 of 5 people missed the export button. Clips and the full write-up are in the report.' }],
  'Content Designer': [{ kind: 'review', title: 'Error messages rewritten for checkout', summary: '14 messages now say what happened and what to do next. Review the tone before they go to the UI desk.' }],
  'Motion Designer': [{ kind: 'review', title: 'Loading animation v1', summary: 'A 1.2s loop that respects reduced motion. Lottie file and a GIF preview in the report.' }],
  'Design Systems Engineer': [{ kind: 'review', title: 'Color tokens for dark mode', summary: 'Every surface and text token has a dark value, all pass AA contrast. Review before I publish the library.' }],
};

/** Background work each desk picks up on its own when its queue is empty. */
const ROUTINES: Record<string, string[]> = {
  COO: ['Checking every desk for blockers', 'Rebalancing the week against your calendar', 'Writing the standup summary'],
  'Report Desk + EA': ['Clearing the inbox and drafting replies', 'Compiling the EOD report', 'Confirming tomorrow’s meetings'],
  'Pipeline Desk': ['Following up on stale deals', 'Updating next steps on open deals', 'Prepping call notes for tomorrow'],
  'Social Prospecting': ['Scoring new LinkedIn connections', 'Drafting first-touch messages', 'Checking replies to last week’s outreach'],
  'Social + Inbound': ['Answering community DMs', 'Tagging warm inbound leads for the pipeline desk', 'Scheduling this week’s posts'],
  'Automation Builder': ['Monitoring automations for failures', 'Cleaning up webhook logs', 'Testing the lead-alert flow'],
  Designer: ['Drafting next week’s thumbnails', 'Refreshing the carousel template', 'Exporting assets to the shared folder'],
  'HR + Compliance': ['Reconciling timesheets', 'Reviewing the contractor agreements', 'Updating the policy handbook'],
  'Tech Lead': ['Grooming the backlog', 'Reading through last week’s merged changes', 'Updating the architecture notes'],
  'Frontend Engineer': ['Auditing components for accessibility', 'Cleaning up unused styles', 'Checking bundle size'],
  'Backend Engineer': ['Reviewing slow API endpoints', 'Tidying database migrations', 'Checking error logs'],
  'QA Engineer': ['Running the regression suite', 'Triaging new bug reports', 'Writing missing unit tests'],
  'DevOps Engineer': ['Watching the CI pipeline', 'Checking dependency updates', 'Reviewing infra costs'],
  'Code Reviewer': ['Reviewing open pull requests', 'Scanning for outdated packages', 'Checking lint warnings'],
  'Docs Writer': ['Updating the changelog', 'Fixing stale README sections', 'Documenting new endpoints'],
  'Design Lead': ['Reviewing work in progress across desks', 'Updating the design brief', 'Planning this week’s critique'],
  'Product Designer': ['Mapping the current signup flow', 'Sketching edge cases for empty states', 'Updating the clickable prototype'],
  'UI Designer': ['Tidying spacing on the dashboard screens', 'Refreshing the icon set', 'Checking mockups at mobile widths'],
  'Brand Designer': ['Updating the brand guidelines', 'Drafting social templates', 'Collecting moodboard references'],
  'UX Researcher': ['Tagging interview notes', 'Writing the next survey', 'Reviewing support tickets for patterns'],
  'Content Designer': ['Auditing button labels', 'Updating the voice and tone guide', 'Rewriting empty-state copy'],
  'Motion Designer': ['Tuning easing curves for transitions', 'Exporting Lottie files', 'Prototyping a hover micro-interaction'],
  'Design Systems Engineer': ['Syncing tokens with the code', 'Documenting components in Storybook', 'Checking color contrast across themes'],
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

const QA_PASSES = [
  'Read the changed files against the ticket. It does what was asked and nothing nearby looks broken. Run the unit tests once before release.',
  'Checked the change and the report. Matches the ticket. Worth a quick manual pass on mobile.',
];
const QA_ISSUES = [
  'The empty state from the ticket is missing: nothing shows when the list has no rows.',
  'The error message still reads "Something went wrong"; the ticket asks for the real reason.',
  'The new field is not validated: a blank value gets saved.',
];

/** Sim QA: the QA desk passes most tickets in QA and fails some, one tick at a time. */
function tickQa(p: Project): void {
  const s = p.state;
  for (const item of s.items.filter((i) => i.status === 'qa')) {
    if (Math.random() > 0.5) continue;
    const by = item.qa?.by ?? qaDeskOf(s)?.id;
    if (!by) continue;
    const pass = Math.random() < 0.7;
    const verdict: QaVerdict = pass
      ? { result: 'pass', summary: pick(QA_PASSES) ?? 'Looks right.' }
      : { result: 'fail', summary: 'Most of it is right, but one thing from the ticket is missing.', issues: [pick(QA_ISSUES) ?? 'Something is missing.'] };
    const outcome = recordQaResult(s, item, by, verdict, [], undefined, signoffOn(p.meta));
    if (typeof outcome === 'string') continue;
    const desk = s.agents.find((a) => a.id === by);
    if (desk) desk.lastActive = now();
    p.log(by, outcome === 'signoff' || outcome === 'done' ? `Passed QA on ${p.ticket(item)} "${item.title}"` : `Failed QA on ${p.ticket(item)} "${item.title}"`);
  }
}

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
  const finish = { qa: hasQa(p.meta.template), signoff: signoffOn(p.meta) };
  tickComments(p);
  // Paused, or this project's model held: the team starts nothing on its own. Answers to your comments still come.
  if (globalHold(Date.now(), projectProvider(p.meta))) {
    settleInstructions(s);
    refreshStatuses(s);
    p.commit();
    return;
  }
  tickQa(p);

  // Idle desks pick up routine work so the office never goes quiet.
  for (const agent of s.agents) {
    if (agent.isHuman || agent.status === 'off') continue;
    const busy = s.items.some((i) => i.assignee === agent.id && (i.status === 'in-progress' || i.status === 'sent-back' || i.status === 'todo'));
    if (busy || Math.random() > 0.6) continue;
    const title = pick(ROUTINES[agent.role] ?? []);
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
    const where = finishWork(s, done, 'carried out what you approved', finish);
    p.log(done.assignee, where === 'done' ? `Finished "${done.title}"` : `Finished "${done.title}", ${where === 'qa' ? 'sent to QA' : 'ready for your sign-off'}`);
  }

  const active = s.items.filter((i) => i.status === 'in-progress' || i.status === 'sent-back');

  // Goal mode: the lead plans a step or two toward the goal, as a live lead would.
  if (p.meta.autopilot && p.meta.goalMode && !autoGate(p) && planDue(s, p.meta)) {
    const lead = plannerOf(s);
    const g = goalState(s, p.meta);
    if (lead && g) {
      g.lastPlanAt = now();
      countStart(s);
      const desks = s.agents.filter((a) => !a.isHuman && a.status !== 'off');
      const made = Math.min(2, desks.length);
      for (let i = 0; i < made; i++) {
        const desk = pick(desks)!;
        createGoalTicket(p, lead.id, { to: desk.name, title: `Next step toward the goal (${p.state.seq + 1})`, brief: `Sim: a step ${lead.name} planned toward the goal.` }, i);
      }
      recordGoalStatus(p, lead.id, 'on-track', `Planned ${made} more step${made === 1 ? '' : 's'}.`);
    }
  }

  if (p.meta.autopilot) {
    // Autopilot: free desks take their oldest To do ticket, as live ones do, within today's limits.
    for (const pick of pickStarts(s, p.meta, 2)) {
      if (autoGate(p)) break;
      const next = s.items.find((i) => i.id === pick.itemId);
      if (!next) continue;
      next.status = 'in-progress';
      next.history.push({ ts: now(), text: 'Started by Autopilot: it was next in To do' });
      countStart(s);
      const agent = s.agents.find((a) => a.id === pick.agentId);
      if (agent) {
        agent.currentTask = next.title;
        agent.lastActive = now();
      }
      p.log(pick.agentId, `Autopilot started ${p.ticket(next)} "${next.title}"`);
    }
  } else if (Math.random() < 0.35) {
    // Occasionally start a queued item.
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
      // The sim's own routine busywork skips QA and sign-off, so your sign-off list only holds real tickets.
      const routine = item.client === 'Routine';
      const where = finishWork(s, item, 'Finished the work on the ticket', routine ? { qa: false, signoff: false } : finish);
      p.log(item.assignee, where === 'done' ? `Finished "${item.title}"` : `Finished "${item.title}", ${where === 'qa' ? 'sent to QA' : 'ready for your sign-off'}`);
      if (agent) {
        agent.currentTask = 'Wrapping up and looking for the next task';
        agent.lastActive = now();
      }
    } else if (roll < 0.45) {
      const follow = pick((agent && FOLLOW_UPS[agent.role]) || []);
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
