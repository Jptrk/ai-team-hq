import { CircleAlert, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { useRef } from 'react';
import { IMAGE_ACCEPT, imageFiles } from '../../lib/images';
import type { AttachmentsState } from './useAttachments';

/** Paperclip-style button that opens the file picker. */
export function AttachButton({ att, label = 'Attach images', disabled }: { att: AttachmentsState; label?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="icon-btn sm" onClick={() => input.current?.click()} disabled={disabled || att.full} aria-label={label} title={att.full ? 'Image limit reached' : `${label} (or paste)`}>
        <ImagePlus size={16} />
      </button>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          att.add(imageFiles(e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Thumbnails of images about to be sent, with progress, errors and remove. */
export function AttachmentTray({ att }: { att: AttachmentsState }) {
  if (!att.drafts.length && !att.notice) return null;
  return (
    <div className="att-tray">
      {att.drafts.length > 0 && (
        <ul className="att-tray-list" aria-label="Images to send">
          {att.drafts.map((d, i) => (
            <li key={d.key} className={`att-draft ${d.status}`} title={d.error}>
              <img src={d.preview} alt={`Image ${i + 1}`} />
              {d.status === 'uploading' && (
                <span className="att-draft-state" aria-label="Uploading">
                  <LoaderCircle size={16} className="spin" aria-hidden />
                </span>
              )}
              {d.status === 'error' && (
                <span className="att-draft-state" aria-label={d.error ?? 'Upload failed'}>
                  <CircleAlert size={16} aria-hidden />
                </span>
              )}
              <button type="button" className="att-remove" onClick={() => att.remove(d.key)} aria-label={`Remove image ${i + 1}`} title="Remove">
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(att.notice || att.failed) && (
        <p className="field-hint bad" role="status">
          {att.notice ?? att.drafts.find((d) => d.status === 'error')?.error}
        </p>
      )}
    </div>
  );
}
