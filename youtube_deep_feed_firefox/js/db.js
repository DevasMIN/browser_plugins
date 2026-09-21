// Локальное хранилище (IndexedDB): каналы, видео, отметки просмотра, скрытое.
// Старые видео скачиваются один раз и дальше читаются только с диска.

const DB_NAME = 'yt_deep_feed';
const DB_VER = 2;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      // {id, title, thumb, enabled, hiddenChannel, backfillDone, nextToken, plKind, lastSync, videoCount}
      if (!db.objectStoreNames.contains('channels')) db.createObjectStore('channels', { keyPath: 'id' });
      // {id, ch, title, dur, views, pubText, ts, addedAt}
      if (!db.objectStoreNames.contains('videos')) {
        const videos = db.createObjectStore('videos', { keyPath: 'id' });
        videos.createIndex('ts_id', ['ts', 'id']);
        videos.createIndex('ch', 'ch');
      }
      // {id, pct, src, at}  src: playlist | history | manual
      if (!db.objectStoreNames.contains('watched')) db.createObjectStore('watched', { keyPath: 'id' });
      // {id, at}
      if (!db.objectStoreNames.contains('hidden')) db.createObjectStore('hidden', { keyPath: 'id' });
      // {k, v}
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      // {id, blob, at} — кэш картинок превью, чтобы не дёргать i.ytimg.com
      // повторно и чтобы можно было явно чистить его по видео (при скрытии).
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await openDb();
  return reqAsPromise(tx(db, store).getAll());
}

export async function get(store, key) {
  const db = await openDb();
  return reqAsPromise(tx(db, store).get(key));
}

export async function put(store, value) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readwrite').put(value));
}

export async function del(store, key) {
  const db = await openDb();
  return reqAsPromise(tx(db, store, 'readwrite').delete(key));
}

export async function bulkPut(store, values) {
  if (!values.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getAllByIndex(store, indexName, key) {
  const db = await openDb();
  return reqAsPromise(tx(db, store).index(indexName).getAll(key));
}

export async function count(store, indexName, key) {
  const db = await openDb();
  const s = tx(db, store);
  const target = indexName ? s.index(indexName) : s;
  return reqAsPromise(key !== undefined ? target.count(key) : target.count());
}

export async function metaGet(k, dflt = null) {
  const row = await get('meta', k);
  return row ? row.v : dflt;
}

export async function metaSet(k, v) {
  return put('meta', { k, v });
}

/**
 * Страница ленты: видео по ts начиная после курсора, в порядке dir
 * ('desc' — новые сначала, 'asc' — старые сначала).
 * accept(video) — фильтр (просмотренные/скрытые/поиск); собирает до limit штук.
 * Возвращает {items, cursor, done}; cursor = [ts, id] последнего элемента.
 */
export async function pageVideos({ cursor = null, limit = 60, accept = () => true, dir = 'desc' }) {
  const db = await openDb();
  const idx = tx(db, 'videos').index('ts_id');
  const range = cursor
    ? (dir === 'asc' ? IDBKeyRange.lowerBound(cursor, true) : IDBKeyRange.upperBound(cursor, true))
    : null;
  const items = [];
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(range, dir === 'asc' ? 'next' : 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve({ items, cursor: null, done: true });
        return;
      }
      const v = cur.value;
      if (accept(v)) items.push(v);
      if (items.length >= limit) {
        resolve({ items, cursor: [v.ts, v.id], done: false });
        return;
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
