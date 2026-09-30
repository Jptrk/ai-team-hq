/** localStorage that never throws (private windows, blocked storage, previews). Per-browser conveniences only. */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const KEYS = {
  lastProject: 'hq.lastProject',
  theme: 'hq.theme',
  sidebar: 'hq.sidebar',
  reportView: 'hq.reportView',
} as const;
