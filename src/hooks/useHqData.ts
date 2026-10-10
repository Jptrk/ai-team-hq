import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meta, ProjectSummary, StateResponse } from '../../shared/types';
import { api } from '../api';

const POLL_MS = 3000;
const PROJECTS_POLL_MS = 6000;

/** Server data: meta once, projects every 6s, the open project's state every 3s. */
export function useHqData(pid: string | null) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pidRef = useRef(pid);
  pidRef.current = pid;
  /** Set while a board card is being dragged, so a poll can't remount it mid-drag. */
  const paused = useRef(false);
  /** Counts the meta changes you made here. A poll sent before one may answer after it: its meta is older, so it is ignored. */
  const metaRev = useRef(0);
  const changeMeta = useCallback((next: Meta) => {
    metaRev.current += 1;
    setMeta(next);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.projects());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the HQ server');
    }
  }, []);

  // Meta changes without this page: the server holds a model's projects when its usage limit is hit, and another tab can resume.
  const loadMeta = useCallback(() => {
    const rev = metaRev.current;
    void api.meta().then(
      (next) => {
        if (rev === metaRev.current) setMeta((m) => (m && JSON.stringify(m) === JSON.stringify(next) ? m : next));
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    loadMeta();
    void loadProjects();
    const handle = window.setInterval(() => {
      void loadProjects();
      loadMeta();
    }, PROJECTS_POLL_MS);
    return () => window.clearInterval(handle);
  }, [loadProjects, loadMeta]);

  const refresh = useCallback(async (force = false) => {
    const want = pidRef.current;
    if (!want || (paused.current && !force)) return;
    try {
      const rev = metaRev.current;
      const next = await api.state(want);
      // Ignore a slow response for a project the user already left, or one that lands mid-drag.
      if (pidRef.current === want && (!paused.current || force)) setState(next);
      // The state carries meta too: a pause shows within one poll on a project page.
      setMeta((m) => {
        if (!m || rev !== metaRev.current) return m;
        const merged = { ...m, ...next.meta };
        return JSON.stringify(merged) === JSON.stringify(m) ? m : merged;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the HQ server');
    }
  }, []);

  useEffect(() => {
    setState(null);
    if (!pid) return;
    void refresh(true);
    const handle = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(handle);
  }, [pid, refresh]);

  const after = useCallback(async () => {
    await Promise.all([refresh(true), loadProjects()]);
  }, [refresh, loadProjects]);

  const setPollPaused = useCallback((on: boolean) => {
    paused.current = on;
  }, []);

  // setMeta for a change you just made (it wins over polls already on their way).
  return { meta, setMeta: changeMeta, projects, state, error, refresh, loadProjects, after, setPollPaused };
}
