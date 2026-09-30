import { useRef, type KeyboardEvent } from 'react';

interface Props<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  /** tabs = WAI-ARIA tablist (arrow keys); buttons = pressed buttons. */
  as?: 'tabs' | 'buttons';
}

export function Segmented<T extends string>({ value, options, onChange, label, as = 'buttons' }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (as !== 'tabs' || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div ref={ref} className="segmented" role={as === 'tabs' ? 'tablist' : 'group'} aria-label={label} onKeyDown={onKey}>
      {options.map((o) =>
        as === 'tabs' ? (
          <button key={o.value} type="button" role="tab" aria-selected={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ) : (
          <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ),
      )}
    </div>
  );
}
