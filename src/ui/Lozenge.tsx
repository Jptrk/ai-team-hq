import type { ReactNode } from 'react';
import type { ItemStatus } from '../../shared/types';
import { ITEM_STATUS_LABEL, ITEM_STATUS_TONE, type Tone } from '../util';

export function Lozenge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`lozenge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StatusLozenge({ status }: { status: ItemStatus }) {
  return <Lozenge tone={ITEM_STATUS_TONE[status]}>{ITEM_STATUS_LABEL[status]}</Lozenge>;
}
