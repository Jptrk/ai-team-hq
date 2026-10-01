import { createContext, useContext, useEffect, useId } from 'react';

/** Editors inside one area (the ticket modal) that hold text not saved yet. */
export interface DraftGuard {
  set: (id: string, dirty: boolean) => void;
  dirty: () => boolean;
}

export function createDraftGuard(): DraftGuard {
  const dirty = new Set<string>();
  return {
    set: (id, on) => {
      if (on) dirty.add(id);
      else dirty.delete(id);
    },
    dirty: () => dirty.size > 0,
  };
}

const DraftGuardContext = createContext<DraftGuard | null>(null);
export const DraftGuardProvider = DraftGuardContext.Provider;

/** Tell the surrounding area this editor has unsaved text. Outside a guarded area it does nothing. */
export function useUnsavedDraft(dirty: boolean): void {
  const guard = useContext(DraftGuardContext);
  const id = useId();
  useEffect(() => {
    if (!guard || !dirty) return;
    guard.set(id, true);
    return () => guard.set(id, false);
  }, [guard, id, dirty]);
}
