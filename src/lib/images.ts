import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../shared/types';

/** File picker filter. */
export const IMAGE_ACCEPT = ATTACHMENT_TYPES.join(',');
/** Claude's recommended long side. Bigger images are scaled down before upload. */
export const MAX_SIDE = 1568;

export function isAttachableType(type: string): boolean {
  return (ATTACHMENT_TYPES as string[]).includes(type);
}

/** Size that fits inside max x max, keeping the aspect ratio. Never scales up. */
export function fitWithin(w: number, h: number, max = MAX_SIDE): { w: number; h: number; scaled: boolean } {
  const long = Math.max(w, h);
  if (long <= max || long <= 0) return { w, h, scaled: false };
  const k = max / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

/** Image files from a paste, a drop, or a file picker. Other files are left out. */
export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => isAttachableType(f.type));
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Scale big images down to MAX_SIDE and keep them under the size cap. PNG stays PNG so
 * screenshots keep sharp text; JPEG is the fallback when a PNG is still too big. GIFs are
 * sent as they are, so animations survive.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('GIFs can be at most 3.75 MB.');
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That image could not be read.');
  }
  try {
    const fit = fitWithin(bitmap.width, bitmap.height);
    if (!fit.scaled && file.size <= MAX_ATTACHMENT_BYTES) return file;
    let { w, h } = fit;
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      if (!g) break;
      g.drawImage(bitmap, 0, 0, w, h);
      const keepPng = file.type === 'image/png' && attempt === 0;
      const blob = await toBlob(canvas, keepPng ? 'image/png' : 'image/jpeg', keepPng ? undefined : 0.88);
      if (blob && blob.size <= MAX_ATTACHMENT_BYTES) return blob;
      // Still too big: drop to JPEG, then shrink.
      if (attempt > 0) {
        w = Math.max(1, Math.round(w * 0.75));
        h = Math.max(1, Math.round(h * 0.75));
      }
    }
    throw new Error('That image is too large, even scaled down.');
  } finally {
    bitmap.close();
  }
}
