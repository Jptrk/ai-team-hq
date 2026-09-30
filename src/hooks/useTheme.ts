import { useCallback, useEffect, useState } from 'react';
import { KEYS, storage } from '../lib/storage';

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  const v = storage.get(KEYS.theme);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function resolve(pref: ThemePref): Theme {
  if (pref !== 'system') return pref;
  try {
    return query().matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const brand = getComputedStyle(root).getPropertyValue('--brand').trim();
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  if (brand) meta.content = brand;
}

/** Follows the system until you pick one; the pick is remembered. index.html sets it before first paint. */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<Theme>(() => resolve(readPref()));

  useEffect(() => {
    const next = resolve(pref);
    setTheme(next);
    apply(next);
    if (pref !== 'system') return;
    let mq: MediaQueryList;
    try {
      mq = query();
    } catch {
      return;
    }
    const onChange = () => {
      const t = mq.matches ? 'dark' : 'light';
      setTheme(t);
      apply(t);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    if (p === 'system') storage.remove(KEYS.theme);
    else storage.set(KEYS.theme, p);
    setPrefState(p);
  }, []);

  const toggle = useCallback(() => setPref(theme === 'dark' ? 'light' : 'dark'), [setPref, theme]);

  return { pref, theme, setPref, toggle };
}
