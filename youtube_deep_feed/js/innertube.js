// Слой доступа к внутреннему API YouTube (innertube).
// Работает со страницы расширения: куки youtube.com подхватываются через
// host_permissions, авторизация — заголовком SAPISIDHASH (как делает сам сайт).

const YT = 'https://www.youtube.com';

let cachedCfg = null;

/** API-ключ и версия клиента из HTML любой страницы YouTube (кэш 12ч). */
export async function getConfig() {
  if (cachedCfg) return cachedCfg;
  const stored = await chrome.storage.local.get('itCfg');
  if (stored.itCfg && Date.now() - stored.itCfg.at < 12 * 3600e3) {
    cachedCfg = stored.itCfg;
    return cachedCfg;
  }
  const r = await fetch(`${YT}/?hl=ru`, { credentials: 'include' });
  const html = await r.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
  if (!key || !ver) throw new Error('Не удалось получить конфигурацию YouTube (вы залогинены?)');
  cachedCfg = { key, ver, at: Date.now() };
  await chrome.storage.local.set({ itCfg: cachedCfg });
  return cachedCfg;
}

/** Заголовок Authorization: SAPISIDHASH — так YouTube авторизует запросы к API. */
async function sapisidHash() {
  const cookie =
    (await chrome.cookies.get({ url: YT, name: 'SAPISID' })) ||
    (await chrome.cookies.get({ url: YT, name: '__Secure-3PAPISID' }));
  if (!cookie) return null;
  const ts = Math.floor(Date.now() / 1000);
  const raw = `${ts} ${cookie.value} ${YT}`;
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

async function directApi(endpoint, body) {
  const cfg = await getConfig();
  const auth = await sapisidHash();
  const headers = {
    'Content-Type': 'application/json',
    'X-Origin': YT,
    'X-Goog-AuthUser': '0',
  };
  if (auth) headers['Authorization'] = auth;

  const payload = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: cfg.ver, hl: 'ru', gl: 'RU' } },
    ...body,
  });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${YT}/youtubei/v1/${endpoint}?key=${cfg.key}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: payload,
    });
    if (r.ok) return r.json();
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    // 401/403 — не ретраим: авторизация со страницы расширения не работает,
    // переключаемся на реле через вкладку youtube.com
    if (r.status === 401 || r.status === 403) throw err;
    lastErr = err;
    await sleep(3000 * (attempt + 1));
  }
  throw lastErr;
}

// ---------- Реле через вкладку youtube.com ----------

let relayTabId = null;

async function pingTab(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return !!(resp && resp.ok);
  } catch (e) {
    return false;
  }
}

async function getStoredRelayTab() {
  try {
    const s = await chrome.storage.session.get('relayTabId');
    return s.relayTabId ?? null;
  } catch (e) {
    return null;
  }
}

async function setStoredRelayTab(id) {
  try {
    await chrome.storage.session.set({ relayTabId: id });
  } catch (e) {
    /* ignore */
  }
}

/**
 * Находит вкладку youtube.com с работающим реле или создаёт свою.
 * Нужен только как запасной путь, если DNR-переписывание Origin не помогло и
 * прямой запрос всё равно даёт 403. Дедуплицируется: одну вкладку переиспользуем
 * между перезагрузками ленты (id в storage.session), предпочитаем уже открытую
 * вкладку YouTube и НЕ закрепляем.
 */
async function ensureRelayTab() {
  if (relayTabId != null && (await pingTab(relayTabId))) return relayTabId;

  const stored = await getStoredRelayTab();
  if (stored != null && (await pingTab(stored))) {
    relayTabId = stored;
    return relayTabId;
  }
  relayTabId = null;

  // Уже открытые вкладки YouTube
  for (const tab of await chrome.tabs.query({ url: '*://www.youtube.com/*' })) {
    if (await pingTab(tab.id)) {
      relayTabId = tab.id;
      await setStoredRelayTab(tab.id);
      return relayTabId;
    }
  }

  // Своя фоновая вкладка (не закреплённая), переиспользуется в дальнейшем
  const tab = await chrome.tabs.create({ url: `${YT}/?hl=ru`, pinned: false, active: false });
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    if (await pingTab(tab.id)) {
      relayTabId = tab.id;
      await setStoredRelayTab(tab.id);
      return relayTabId;
    }
  }
  throw new Error('Не удалось запустить реле во вкладке youtube.com');
}

async function relayApi(endpoint, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tabId = await ensureRelayTab();
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tabId, { type: 'api', endpoint, body });
    } catch (e) {
      relayTabId = null; // вкладку закрыли — пересоздадим
      continue;
    }
    if (resp && resp.ok) return resp.json;
    const msg = resp ? resp.error : 'нет ответа от реле';
    // Временные ошибки сети/лимитов — подождать и повторить
    if (/HTTP (429|5\d\d)/.test(msg) && attempt === 0) {
      await sleep(5000);
      continue;
    }
    throw new Error(msg);
  }
  throw new Error('Реле не отвечает');
}

let useRelay = false;

/** POST к внутреннему API: прямой запрос, при 401/403 — реле. */
async function api(endpoint, body) {
  if (!useRelay) {
    try {
      return await directApi(endpoint, body);
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      useRelay = true;
    }
  }
  return relayApi(endpoint, body);
}

export function browse(body) {
  return api('browse', body);
}

/** Отправляет отзыв «Скрыть» — видео пропадает и из нативной ленты YouTube. */
export function sendFeedback(token) {
  return api('feedback', {
    feedbackTokens: [token],
    isFeedbackTokenUnencrypted: false,
    shouldMerge: false,
  });
}

/** Добавляет видео в плейлист «Смотреть позже». */
export async function addToWatchLater(videoId) {
  const json = await api('browse/edit_playlist', {
    playlistId: 'WL',
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
  });
  if (json && json.status && json.status !== 'STATUS_SUCCEEDED') {
    throw new Error(`Смотреть позже: ${json.status}`);
  }
  return json;
}

/** Убирает видео из плейлиста «Смотреть позже» (для отмены). */
export function removeFromWatchLater(videoId) {
  return api('browse/edit_playlist', {
    playlistId: 'WL',
    actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }],
  });
}

/** Все videoId из плейлиста «Смотреть позже» (playlistId=WL). */
export async function fetchWatchLaterIds() {
  const ids = new Set();
  let json = await browse({ browseId: 'VLWL' });
  for (let page = 0; page < 40; page++) {
    for (const id of parsePlaylistVideoIds(json)) ids.add(id);
    const token = findToken(json);
    if (!token) break;
    await sleep(200);
    json = await browse({ continuation: token });
  }
  return ids;
}

/** videoId из ответа-плейлиста (новый lockupViewModel и старый playlistVideoRenderer). */
export function parsePlaylistVideoIds(json) {
  const ids = new Set();
  for (const l of parseLockups(json)) ids.add(l.id);
  for (const v of collectKey(json, 'playlistVideoRenderer')) {
    if (v && v.videoId) ids.add(v.videoId);
  }
  return [...ids];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Обход JSON-дерева ответов ----------

/** Собирает все значения по ключу key во всём дереве, сохраняя порядок документа. */
export function collectKey(root, key) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === key) out.push(v);
      if (v && typeof v === 'object') walk(v);
    }
  })(root);
  return out;
}

/** Первый токен продолжения в ответе (у наших запросов он один). */
export function findToken(json) {
  return collectKey(json, 'continuationCommand').map((c) => c && c.token).find(Boolean) || null;
}

// ---------- Парсеры ----------

/** Список подписок из FEchannels (+продолжения обрабатывает вызывающий). */
export function parseChannels(json) {
  return collectKey(json, 'channelRenderer')
    .filter((c) => c && c.channelId)
    .map((c) => ({
      id: c.channelId,
      title: c.title?.simpleText || c.title?.runs?.[0]?.text || c.channelId,
      thumb: bestThumb(c.thumbnail),
    }));
}

/**
 * Видео из плейлиста загрузок (новый формат lockupViewModel).
 * Возвращает {id, title, dur, views, pubText, percent}.
 */
export function parseLockups(json) {
  return collectKey(json, 'lockupViewModel')
    .filter((l) => l && l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && l.contentId)
    .map((l) => {
      const meta = l.metadata?.lockupMetadataViewModel;
      const texts = collectKey(meta?.metadata || {}, 'content').filter((t) => typeof t === 'string');
      const pubText = texts.find((t) => /назад|ago/i.test(t)) || null;
      const views = texts.find((t) => /просмотр|view/i.test(t)) || null;
      const badges = collectKey(l.contentImage || {}, 'thumbnailBadgeViewModel');
      const dur = badges.map((b) => b && b.text).find((t) => /^[\d:]+$/.test(t || '')) || null;
      const prog = collectKey(l.contentImage || {}, 'thumbnailOverlayProgressBarViewModel')[0];
      const chId =
        collectKey(l, 'browseId').find((b) => typeof b === 'string' && b.startsWith('UC')) || null;
      // Токен пункта меню «Скрыть» (есть только у элементов нативной ленты) —
      // с ним видео можно скрыть и на самом YouTube через /feedback
      let fbToken = null;
      for (const mi of collectKey(l, 'listItemViewModel')) {
        const t = collectKey(mi, 'feedbackToken')[0];
        if (t) {
          fbToken = t;
          break;
        }
      }
      return {
        fbToken,
        id: l.contentId,
        chId,
        title: meta?.title?.content || '',
        dur,
        views,
        pubText,
        percent: prog && typeof prog.startPercent === 'number' ? prog.startPercent : null,
      };
    });
}

/** Видео из истории просмотра FEhistory: {id, percent}. */
export function parseHistory(json) {
  const out = [];
  for (const v of collectKey(json, 'videoRenderer')) {
    if (!v || !v.videoId) continue;
    const resume = collectKey(v, 'percentDurationWatched')[0];
    out.push({ id: v.videoId, percent: typeof resume === 'number' ? resume : 100 });
  }
  // На случай перевода истории на новый формат
  for (const l of parseLockups(json)) {
    out.push({ id: l.id, percent: l.percent == null ? 100 : l.percent });
  }
  return out;
}

function bestThumb(thumbnail) {
  const arr = thumbnail?.thumbnails;
  return normThumbUrl(Array.isArray(arr) && arr.length ? arr[arr.length - 1].url : null);
}

/**
 * Приводит URL превью к абсолютному https. YouTube часто отдаёт
 * протокол-относительные ссылки (`//yt3.ggpht.com/…`), а на странице расширения
 * `//` резолвится в `chrome-extension://…` и картинка не грузится.
 */
export function normThumbUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

// ---------- Относительные даты ----------

// [регэксп единицы, длительность единицы, гранулярность округления]
// Гранулярность = реальная точность даты: «8 месяцев назад» знает дату
// с точностью до дня, «5 часов назад» — до часа.
const UNIT_MS = [
  [/сек|second/i, 1e3, 60e3],
  [/мин|minute/i, 60e3, 60e3],
  [/час|hour/i, 3600e3, 3600e3],
  [/\bдн|день|day/i, 86400e3, 86400e3],
  [/недел|week/i, 7 * 86400e3, 86400e3],
  [/месяц|month/i, 30.44 * 86400e3, 86400e3],
  [/год|лет|year/i, 365.25 * 86400e3, 86400e3],
];

function matchRelativeDate(text) {
  if (!text) return null;
  const t = text.replace(/^(Трансляция закончилась|Премьера состоялась|Streamed|Premiered)\s*/i, '');
  const m = t.match(/(\d+)\s*(\S+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  for (const [re, ms, g] of UNIT_MS) {
    if (re.test(m[2])) return { n, ms, g };
  }
  return null;
}

/**
 * «18 часов назад» / «2 years ago» → примерный timestamp публикации.
 * Точность падает с возрастом видео — для сортировки этого достаточно.
 */
export function parseRelativeDate(text, now = Date.now()) {
  const m = matchRelativeDate(text);
  return m ? now - m.n * m.ms : null;
}

/**
 * Каноничная метка публикации: оценка «now − n·unit», округлённая вниз до
 * гранулярности единицы. Без округления одинаковые даты («8 месяцев назад»)
 * у разных каналов расходились на секунды (каналы синхронизируются по очереди),
 * и лента внутри одной «корзины» дат группировалась блоками по каналам.
 * Возвращает { ts, g } или null.
 */
export function canonicalPubTs(text, now = Date.now()) {
  const m = matchRelativeDate(text);
  if (!m) return null;
  const raw = now - m.n * m.ms;
  return { ts: Math.floor(raw / m.g) * m.g, g: m.g };
}
