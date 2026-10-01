import type { HuddleKind, HuddleLane } from './types';

/** Huddles: a team session you start. Shared by the server and the UI so the numbers always agree. */

export const HUDDLE_KIND_LABEL: Record<HuddleKind, string> = { retro: 'Retro', brainstorm: 'Brainstorm', planning: 'Planning' };

export const HUDDLE_KIND_HINT: Record<HuddleKind, string> = {
  retro: 'What worked, what did not, what to change. Ends with action items and note updates for you to approve.',
  brainstorm: 'Ideas from each desk, then a shortlist and a pick with reasons.',
  planning: 'A goal broken into tickets with owners, proposed to you before anything starts.',
};

export const MIN_HUDDLE_DESKS = 2;
export const MAX_HUDDLE_DESKS = 6;
export const MAX_HUDDLE_ROUNDS = 3;
export const MAX_HUDDLE_TOPIC = 1000;
/** Longest team notes, in markdown characters. They go into prompts, so they stay short. */
export const MAX_TEAM_NOTES = 8000;
/** Longest note you add to a running huddle. */
export const MAX_STEER = 1000;

/** The board columns each kind fills, in order. */
export const HUDDLE_LANES: Record<HuddleKind, { lane: HuddleLane; label: string }[]> = {
  retro: [
    { lane: 'went-well', label: 'Went well' },
    { lane: 'didnt', label: 'Did not go well' },
    { lane: 'try', label: 'Try next' },
  ],
  brainstorm: [{ lane: 'idea', label: 'Ideas' }],
  planning: [{ lane: 'task', label: 'Proposed tasks' }],
};

/**
 * Desk runs a huddle takes: one turn per desk per round, plus the facilitator's summary each round.
 * The facilitator's own contribution, when it takes part, is one of the desk turns.
 */
export function estimateHuddleRuns(desks: number, rounds: number): number {
  return Math.max(0, desks) * Math.max(0, rounds) + Math.max(0, rounds);
}

/** Rough token count of text, for the cost hint next to "Include team notes". About 4 characters a token. */
export function roughTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}
