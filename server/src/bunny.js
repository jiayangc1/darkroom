import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import config from './config.js';

const { storageZone, accessKey, storageHost, cdnBase } = config.bunny;

const objectUrl = (p) =>
  `https://${storageHost}/${encodeURIComponent(storageZone)}/${p.split('/').map(encodeURIComponent).join('/')}`;

class StorageError extends Error {
  constructor(op, p, status, body) {
    super(`bunny ${op} ${p} failed: ${status} ${body?.slice(0, 200) || ''}`);
    this.code = 'storage_error';
    this.status = status;
  }
}

/** Upload a local file (known length) to storage path `p`. */
export async function putFile(p, localFile) {
  const { size } = await stat(localFile);
  const res = await fetch(objectUrl(p), {
    method: 'PUT',
    headers: { AccessKey: accessKey, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(localFile)),
    duplex: 'half',
  });
  if (!res.ok) throw new StorageError('PUT', p, res.status, await res.text().catch(() => ''));
}

/** Returns { stream: Node Readable, size: number|null }. */
export async function getStream(p) {
  const res = await fetch(objectUrl(p), { headers: { AccessKey: accessKey } });
  if (!res.ok) throw new StorageError('GET', p, res.status, await res.text().catch(() => ''));
  const len = res.headers.get('content-length');
  return { stream: Readable.fromWeb(res.body), size: len ? Number(len) : null };
}

/** Delete; a missing object counts as success. */
export async function remove(p) {
  const res = await fetch(objectUrl(p), { method: 'DELETE', headers: { AccessKey: accessKey } });
  if (!res.ok && res.status !== 404) throw new StorageError('DELETE', p, res.status, await res.text().catch(() => ''));
}

export const cdnUrl = (p) => `${cdnBase}/${p.split('/').map(encodeURIComponent).join('/')}`;

export default { putFile, getStream, remove, delete: remove, cdnUrl };
