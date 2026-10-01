import { createContext, useContext } from 'react';

/** The open project's id, for components deep in the tree that upload images. */
export const ProjectIdContext = createContext<string | null>(null);

export function useProjectId(): string | null {
  return useContext(ProjectIdContext);
}

/** The open project's team notes, as the "Include team notes" boxes need them. Null when there are none. */
export interface TeamNotesInfo {
  /** Rough tokens the notes add to a run's prompt. */
  tokens: number;
  /** Every run gets them already (project setting). */
  always: boolean;
}

export const TeamNotesContext = createContext<TeamNotesInfo | null>(null);

export function useTeamNotes(): TeamNotesInfo | null {
  return useContext(TeamNotesContext);
}
