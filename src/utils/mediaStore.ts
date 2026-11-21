import type { MediaFileItem, VideoExportFormat } from '../types/api';
import { buildProxyFileUrl } from './streamParser';

const DB_NAME = 'webgpu_studio_media_db';
const DB_VERSION = 1;
const STORE_NAME = 'media_blobs';
const MAX_STORED_ENTRIES = 150;

interface StoredMediaRecord {
  url: string;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  savedAt: number;
}

function openMediaDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveMediaBlob(url: string, blob: Blob): Promise<void> {
  const db = await openMediaDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredMediaRecord = {
        url,
        blob,
        mimeType: blob.type || 'application/octet-stream',
        sizeBytes: blob.size,
        savedAt: Date.now(),
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });

    // Keep store bounded to MAX_STORED_ENTRIES
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('savedAt');
      const allKeysReq = index.getAllKeys();
      allKeysReq.onsuccess = () => {
        const keys = allKeysReq.result;
        if (keys.length > MAX_STORED_ENTRIES) {
          const toDelete = keys.slice(0, keys.length - MAX_STORED_ENTRIES);
          for (const key of toDelete) {
            store.delete(key);
          }
        }
        resolve();
      };
      allKeysReq.onerror = () => resolve();
    });
  } catch {
    // Ignore IndexedDB quota or transaction errors
  } finally {
    db.close();
  }
}

export async function loadMediaBlob(
  url: string
): Promise<{ blob: Blob; mimeType: string; sizeBytes: number } | null> {
  const db = await openMediaDb();
  if (!db) return null;

  try {
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(url);
      req.onsuccess = () => {
        const rec = req.result as StoredMediaRecord | undefined;
        if (rec && rec.blob instanceof Blob) {
          resolve({
            blob: rec.blob,
            mimeType: rec.mimeType || rec.blob.type,
            sizeBytes: rec.sizeBytes || rec.blob.size,
          });
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function deleteMediaBlobs(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const db = await openMediaDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const url of urls) {
        store.delete(url);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore errors
  } finally {
    db.close();
  }
}

/**
 * Triggers a reliable file download for a generated video/image/3D file.
 * Uses local blobUrl if cached, IndexedDB if persisted, or falls back to proxy fetch.
 */
export async function downloadMediaFile(file: MediaFileItem): Promise<void> {
  let blobToSave: Blob | null = null;

  if (file.blobUrl) {
    try {
      const res = await fetch(file.blobUrl);
      if (res.ok) {
        blobToSave = await res.blob();
      }
    } catch {
      // Fallback below
    }
  }

  if (!blobToSave) {
    const stored = await loadMediaBlob(file.originalUrl);
    if (stored) {
      blobToSave = stored.blob;
    }
  }

  if (!blobToSave) {
    const res = await fetch(buildProxyFileUrl(file.originalUrl, false));
    if (!res.ok) {
      throw new Error(`Dosya indirilemedi (HTTP ${res.status})`);
    }
    blobToSave = await res.blob();
    void saveMediaBlob(file.originalUrl, blobToSave);
  }

  const objectUrl = URL.createObjectURL(blobToSave);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = file.filename || 'webgpu-output.mp4';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }
}

/**
 * Exports and downloads a video file in the requested format (`mp4`, `webm`, or `gif`).
 */
export async function exportMediaFile(
  file: MediaFileItem,
  format: VideoExportFormat
): Promise<void> {
  if (format === 'mp4' || file.mediaKind !== 'video') {
    await downloadMediaFile(file);
    return;
  }

  let exportRes = await fetch('/api/video/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: file.originalUrl,
      format,
      filename: file.filename,
    }),
  });

  if (
    !exportRes.ok &&
    (exportRes.status === 404 || exportRes.status === 410 || exportRes.status === 502)
  ) {
    let fallbackBlob: Blob | null = null;
    if (file.blobUrl) {
      try {
        const bRes = await fetch(file.blobUrl);
        if (bRes.ok) fallbackBlob = await bRes.blob();
      } catch {
        // Fallback to IndexedDB below
      }
    }
    if (!fallbackBlob) {
      const stored = await loadMediaBlob(file.originalUrl);
      if (stored) fallbackBlob = stored.blob;
    }
    if (fallbackBlob) {
      const qs = new URLSearchParams({
        format,
        filename: file.filename,
      });
      exportRes = await fetch(`/api/video/export-blob?${qs.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': fallbackBlob.type || 'video/mp4' },
        body: fallbackBlob,
      });
    }
  }

  if (!exportRes.ok) {
    let msg = `${format.toUpperCase()} dışa aktarma hatası (HTTP ${exportRes.status})`;
    try {
      const err = (await exportRes.json()) as { error?: { message?: string } };
      if (err?.error?.message) msg = err.error.message;
    } catch {
      // Fallback
    }
    throw new Error(msg);
  }

  const outBlob = await exportRes.blob();
  const baseName = (file.filename || 'webgpu-video').replace(/\.[a-z0-9]+$/i, '');
  const objectUrl = URL.createObjectURL(outBlob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `${baseName}.${format}`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }
}

