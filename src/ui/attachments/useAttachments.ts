import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { MAX_ATTACHMENTS, type Attachment } from '../../../shared/types';
import { api } from '../../api';
import { imageFiles, prepareImage } from '../../lib/images';

export interface Draft {
  key: string;
  status: 'uploading' | 'ready' | 'error';
  /** Local preview (object URL) shown while uploading and before sending. */
  preview: string;
  attachment?: Attachment;
  error?: string;
}

let seq = 0;

/**
 * Images waiting to be sent with a message, comment, note or ticket. Each one uploads as
 * soon as it is pasted, dropped or picked, so Send only has to pass the ids along.
 */
export function useAttachments(pid: string | null, max = MAX_ATTACHMENTS) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(drafts);
  live.current = drafts;
  const depth = useRef(0);

  // Free the previews when the composer goes away.
  useEffect(() => () => live.current.forEach((d) => URL.revokeObjectURL(d.preview)), []);

  const patch = (key: string, next: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...next } : d)));

  const add = useCallback(
    (files: File[]) => {
      if (!pid || !files.length) return;
      const room = max - live.current.length;
      if (room <= 0) {
        setNotice(`Up to ${max} images at a time.`);
        return;
      }
      setNotice(files.length > room ? `Up to ${max} images at a time. Added the first ${room}.` : null);
      const fresh: Draft[] = files.slice(0, room).map((file) => ({ key: `d${++seq}`, status: 'uploading', preview: URL.createObjectURL(file) }));
      setDrafts((list) => [...list, ...fresh]);
      files.slice(0, room).forEach((file, i) => {
        const key = fresh[i].key;
        prepareImage(file)
          .then((blob) => api.uploadAttachment(pid, blob))
          .then(
            (attachment) => patch(key, { status: 'ready', attachment }),
            (e: unknown) => patch(key, { status: 'error', error: e instanceof Error ? e.message : 'Upload failed' }),
          );
      });
    },
    [pid, max],
  );

  const remove = useCallback((key: string) => {
    setDrafts((list) => {
      const gone = list.find((d) => d.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter((d) => d.key !== key);
    });
    setNotice(null);
  }, []);

  const clear = useCallback(() => {
    live.current.forEach((d) => URL.revokeObjectURL(d.preview));
    setDrafts([]);
    setNotice(null);
  }, []);

  /** What can go out right now: ids of the uploaded drafts, and their keys to remove once sent. */
  const take = useCallback(() => {
    const ready = live.current.filter((d) => d.status === 'ready' && d.attachment);
    return { ids: ready.map((d) => d.attachment!.id), keys: ready.map((d) => d.key) };
  }, []);

  /** Remove just these drafts, after they were sent. Images added in the meantime stay. */
  const removeKeys = useCallback((keys: string[]) => {
    if (!keys.length) return;
    setDrafts((list) => {
      for (const d of list) if (keys.includes(d.key)) URL.revokeObjectURL(d.preview);
      return list.filter((d) => !keys.includes(d.key));
    });
    setNotice(null);
  }, []);

  /** For the area around a composer: drop images onto it. */
  const dropZone = {
    'data-dropping': dropping || undefined,
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      depth.current += 1;
      setDropping(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDropping(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const files = imageFiles(e.dataTransfer.files);
      depth.current = 0;
      setDropping(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      if (files.length) add(files);
      else setNotice('Only PNG, JPEG, WebP and GIF images can be attached.');
    },
  };

  const ready = drafts.filter((d) => d.status === 'ready' && d.attachment);
  return {
    drafts,
    add,
    remove,
    clear,
    take,
    removeKeys,
    dropZone,
    notice,
    /** Ids to send. */
    ids: ready.map((d) => d.attachment!.id),
    uploading: drafts.some((d) => d.status === 'uploading'),
    failed: drafts.some((d) => d.status === 'error'),
    count: drafts.length,
    full: drafts.length >= max,
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;
