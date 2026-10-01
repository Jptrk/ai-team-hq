import { useEffect, useRef } from 'react';

/**
 * One Esc handler at a time: the topmost open layer (menu, then modal, then the ticket modal).
 * While typing in a field, Esc first leaves the field, unless the layer asks otherwise
 * (menus and search close straight away).
 */

interface Layer {
  id: number;
  onEsc: () => void;
  blurFirst: boolean;
}

const stack: Layer[] = [];
let nextId = 1;
let installed = false;

function isTyping(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.isComposing || stack.length === 0) return;
      const top = stack[stack.length - 1];
      e.preventDefault();
      e.stopPropagation();
      if (top.blurFirst && isTyping(e.target)) {
        e.target.blur();
        return;
      }
      top.onEsc();
    },
    true,
  );
}

export function useLayer(active: boolean, onEsc: () => void, opts: { blurFirst?: boolean } = {}): void {
  const handler = useRef(onEsc);
  handler.current = onEsc;
  const blurFirst = opts.blurFirst ?? true;

  useEffect(() => {
    if (!active) return;
    install();
    const layer: Layer = { id: nextId++, onEsc: () => handler.current(), blurFirst };
    stack.push(layer);
    return () => {
      const i = stack.findIndex((l) => l.id === layer.id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active, blurFirst]);
}

export function hasOpenLayer(): boolean {
  return stack.length > 0;
}
