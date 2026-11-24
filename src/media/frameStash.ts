// The timelapse's encoded frames, written to IndexedDB as they're made, so a
// refresh or a closed tab doesn't lose the video: Resume carries on the same
// clip, and Save turns what was kept into one.
//
// Its own database, apart from db.ts: this is scratch space for the session in
// progress, cleared once that session is saved or thrown away.

import type { LayoutSpan } from './timelapse'

const DB_NAME = 'calenduel-stash'
// Anything this old is left over from a session nobody came back to.
const STALE_MS = 24 * 60 * 60_000

export interface StashFormat {
  codec: string // what the encoder was configured with, e.g. avc1.640033
  muxer: 'avc' | 'vp9'
  width: number
  height: number
}

export interface StashedChunk {
  type: EncodedVideoChunkType
  timestamp: number
  duration: number
  data: ArrayBuffer
}

interface StashMeta {
  id: string
  format: StashFormat
  decoderConfig: VideoDecoderConfig | null
  layout: LayoutSpan[]
  updatedAt: number
}

export interface Stash extends StashMeta {
  chunks: StashedChunk[] // in encode order
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('meta', { keyPath: 'id' })
      db.createObjectStore('chunks') // key: [stash id, sequence number]
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Aborted', 'AbortError'))
  })
}

function chunkRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Infinity])
}

// Fire and forget: a frame that can't be kept costs nothing but the rescue.
export function stashChunk(id: string, seq: number, chunk: StashedChunk): void {
  void openDb()
    .then((db) => {
      const tx = db.transaction('chunks', 'readwrite')
      tx.objectStore('chunks').put(chunk, [id, seq])
      return done(tx)
    })
    .catch((e) => console.warn('keeping a timelapse frame failed', e))
}

export function stashMeta(meta: Omit<StashMeta, 'updatedAt'>): void {
  void openDb()
    .then((db) => {
      const tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put({ ...meta, updatedAt: Date.now() })
      return done(tx)
    })
    .catch((e) => console.warn('keeping the timelapse layout failed', e))
}

export async function loadStash(id: string): Promise<Stash | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(['meta', 'chunks'], 'readonly')
    const meta = tx.objectStore('meta').get(id)
    const chunks = tx.objectStore('chunks').getAll(chunkRange(id))
    await done(tx)
    const m = meta.result as StashMeta | undefined
    const c = chunks.result as StashedChunk[]
    // A clip has to open on a keyframe; without one there's nothing to carry on.
    if (!m || c.length === 0 || c[0].type !== 'key') return null
    return { ...m, chunks: c }
  } catch (e) {
    console.warn('reading the kept timelapse failed', e)
    return null
  }
}

// Drops one stash, and any left over from long ago.
export async function clearStash(id: string | null): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(['meta', 'chunks'], 'readwrite')
    const metas = tx.objectStore('meta')
    const chunks = tx.objectStore('chunks')
    const drop = (which: string) => {
      metas.delete(which)
      chunks.delete(chunkRange(which))
    }
    if (id) drop(id)
    const all = metas.getAll()
    all.onsuccess = () => {
      for (const m of all.result as StashMeta[]) {
        if (Date.now() - m.updatedAt > STALE_MS) drop(m.id)
      }
    }
    await done(tx)
  } catch (e) {
    console.warn('clearing the kept timelapse failed', e)
  }
}
