import { useSyncExternalStore } from 'react';

/**
 * Open modal dialogs, oldest first. A modal <dialog> makes the rest of the page inert and draws
 * above it, so anything that must stay visible and usable (flags) renders inside the topmost one.
 */
let open: HTMLDialogElement[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** A dialog just opened. Opening one that is already listed keeps its place. */
export function addDialog(d: HTMLDialogElement): void {
  if (open.includes(d)) return;
  open = [...open, d];
  emit();
}

/** A dialog closed or went away. */
export function removeDialog(d: HTMLDialogElement): void {
  if (!open.includes(d)) return;
  open = open.filter((x) => x !== d);
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const topDialog = () => open[open.length - 1] ?? null;

/** The topmost open modal dialog, or null when none is open. */
export function useTopDialog(): HTMLDialogElement | null {
  return useSyncExternalStore(subscribe, topDialog, () => null);
}
