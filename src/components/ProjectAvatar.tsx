import type { ProjectMeta } from '../../shared/types';
import { readableInk } from '../util';

export function ProjectAvatar({ project, size = 28 }: { project: Pick<ProjectMeta, 'key' | 'color'>; size?: number }) {
  return (
    <span
      className="proj-avatar mono"
      aria-hidden
      style={{ background: project.color, color: readableInk(project.color), width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {project.key.slice(0, 2)}
    </span>
  );
}
