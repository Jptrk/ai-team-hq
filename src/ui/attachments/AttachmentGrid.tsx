import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Attachment } from '../../../shared/types';
import { attachmentUrl, isAttachmentUrl } from '../../markdown/reportLinks';
import { Modal } from '../../shell/Modal';

interface Props {
  pid: string;
  attachments?: Attachment[];
  /** Who sent them, for alt text: "Image 2 from Leo". */
  from?: string;
  size?: 'sm' | 'md';
}

/** Images on a message, comment or ticket. Click one to open it full size. */
export function AttachmentGrid({ pid, attachments, from, size = 'md' }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const list = (attachments ?? []).filter((a) => isAttachmentUrl(attachmentUrl(pid, a.file)));
  if (!list.length) return null;
  const alt = (i: number) => `Image ${i + 1}${from ? ` from ${from}` : ''}`;
  return (
    <>
      <ul className={`att-grid ${size}`} aria-label={`${list.length} image${list.length === 1 ? '' : 's'}`}>
        {list.map((a, i) => (
          <li key={a.id}>
            <button type="button" className="att-thumb" onClick={() => setOpen(i)} title="Open full size">
              <img src={attachmentUrl(pid, a.file)} alt={alt(i)} loading="lazy" decoding="async" />
            </button>
          </li>
        ))}
      </ul>
      <ImageViewer pid={pid} attachments={list} index={open} onIndex={setOpen} alt={alt} />
    </>
  );
}

function ImageViewer({ pid, attachments, index, onIndex, alt }: { pid: string; attachments: Attachment[]; index: number | null; onIndex: (i: number | null) => void; alt: (i: number) => string }) {
  const open = index !== null;
  const n = attachments.length;
  const i = index ?? 0;

  useEffect(() => {
    if (!open || n < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onIndex((i + 1) % n);
      else if (e.key === 'ArrowLeft') onIndex((i - 1 + n) % n);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, i, n, onIndex]);

  const a = attachments[i];
  const url = a ? attachmentUrl(pid, a.file) : '';
  return (
    <Modal open={open} onClose={() => onIndex(null)} title={n > 1 ? `Image ${i + 1} of ${n}` : 'Image'} size="wide">
      {a && (
        <div className="image-viewer">
          <img src={url} alt={alt(i)} />
          <div className="image-viewer-bar">
            {n > 1 && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => onIndex((i - 1 + n) % n)} aria-label="Previous image">
                <ChevronLeft size={14} aria-hidden /> Previous
              </button>
            )}
            <span className="grow" />
            <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden /> Open original
            </a>
            {n > 1 && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => onIndex((i + 1) % n)} aria-label="Next image">
                Next <ChevronRight size={14} aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
