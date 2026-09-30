import { AVATAR_FALLBACK, readableInk } from '../util';

interface Props {
  name: string;
  color?: string;
  size?: number;
  running?: boolean;
  square?: boolean;
  title?: string;
}

export function Avatar({ name, color, size = 24, running, square, title }: Props) {
  const bg = color ?? AVATAR_FALLBACK;
  return (
    <span
      className={`avatar${square ? ' square' : ''}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)), background: bg, color: color ? readableInk(color) : 'var(--text-inverse)' }}
      title={title ?? name}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
      {running && <span className="avatar-run pulse" />}
    </span>
  );
}
