import { Eye, Gavel, Info } from 'lucide-react';
import type { ItemKind } from '../../shared/types';

const LABEL: Record<ItemKind, string> = { decide: 'Decision', review: 'Review', fyi: 'Task' };

export function TypeIcon({ kind }: { kind: ItemKind }) {
  const Icon = kind === 'decide' ? Gavel : kind === 'review' ? Eye : Info;
  return (
    <span className={`type-icon ${kind}`} title={LABEL[kind]}>
      <Icon size={11} strokeWidth={2.5} />
      <span className="sr-only">{LABEL[kind]}</span>
    </span>
  );
}

export const TYPE_LABEL = LABEL;
