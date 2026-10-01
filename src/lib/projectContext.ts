import { createContext, useContext } from 'react';

/** The open project's id, for components deep in the tree that upload images. */
export const ProjectIdContext = createContext<string | null>(null);

export function useProjectId(): string | null {
  return useContext(ProjectIdContext);
}
