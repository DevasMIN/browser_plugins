/* global chrome */

const api = typeof browser !== "undefined" ? browser : chrome;

const CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { url: string, ts: number }>} */
const cache = new Map();
/** JoyReactor раздаёт один и тот же сайт с нескольких доменов/зеркал (joyreactor.cc,
 * joy.reactor.cc, ...). Один из них может временно не отвечать, поэтому запрос
 * идёт на тот домен, с которого реально открыта страница, а не жёстко на один. */
const ALLOWED_ORIGINS = [
  "https://joyreactor.cc",
  "https://joy.reactor.cc",
];
const FETCH_TIMEOUT_MS = 8000;

function pickFirstMatch(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[0]) return m[0];
  }
  return null;
}

function normalizeToAbsolute(url, origin) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  // Protocol-relative — частый случай в разметке JoyReactor (//imgN.reactor.cc/…).
  // Проверять раньше "/" обязательно: "//" тоже начинается с одного "/".
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${origin}${url}`;
  return null;
}

function deriveMp4FromWebm(webmUrl, origin) {
  if (!webmUrl) return null;
  try {
    const u = new URL(webmUrl);
    u.pathname = u.pathname.replace(/\/webm\//i, "/mp4/").replace(/\.webm$/i, ".mp4");
    return u.toString();
  } catch {
    // Best effort for relative paths
    if (webmUrl.startsWith("/")) {
      return `${origin}${webmUrl.replace(/\/webm\//i, "/mp4/").replace(/\.webm$/i, ".mp4")}`;
    }
    return null;
  }
}

/** fetch с таймаутом — без него зависший запрос вешает кнопку в интерфейсе навечно. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function urlExists(url) {
  try {
    const head = await fetchWithTimeout(url, {
      method: "HEAD",
      cache: "no-store",
      credentials: "omit",
    });
    if (head.ok) return true;
    // Some CDNs don't allow HEAD.
    if (head.status && head.status !== 405 && head.status !== 403) return false;
  } catch {
    // ignore
  }

  try {
    // Avoid downloading the whole video: request just the first byte.
    const get = await fetchWithTimeout(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { Range: "bytes=0-0" },
    });
    return get.ok;
  } catch {
    return false;
  }
}

async function extractBestMediaUrl(html, origin) {
  // Домен CDN — imgN.joyreactor.cc или imgN.reactor.cc (без "joy", встречается
  // не реже), протокол в разметке часто опущен (protocol-relative "//…").
  // Prefer MP4 (Telegram preview-friendly)
  const mp4Raw = pickFirstMatch(html, [
    /(?:https?:)?\/\/img\d+\.(?:joy)?reactor\.cc\/pics\/post\/mp4\/[^"'\\\s>]+\.mp4/iu,
    /\/pics\/post\/mp4\/[^"'\\\s>]+\.mp4/iu,
  ]);
  const mp4 = normalizeToAbsolute(mp4Raw, origin);
  if (mp4) return mp4;

  // Fallback: WEBM exists on some posts; try to derive MP4 sibling if present.
  const webmRaw = pickFirstMatch(html, [
    /(?:https?:)?\/\/img\d+\.(?:joy)?reactor\.cc\/pics\/post\/webm\/[^"'\\\s>]+\.webm/iu,
    /\/pics\/post\/webm\/[^"'\\\s>]+\.webm/iu,
  ]);
  const webm = normalizeToAbsolute(webmRaw, origin);
  if (!webm) return null;

  const derivedMp4 = deriveMp4FromWebm(webm, origin);
  // Telegram usually shows preview only for MP4. If we can derive MP4 from WEBM,
  // prefer it even if the existence probe fails due to network/CDN quirks.
  if (derivedMp4) {
    const exists = await urlExists(derivedMp4);
    if (exists) return derivedMp4;
    return derivedMp4; // optimistic fallback: better UX for Telegram
  }

  return webm;
}

async function getMediaLinkForPost(postId, origin) {
  const key = String(postId);
  const now = Date.now();
  const cacheKey = `${origin}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.url;

  const url = `${origin}/post/${encodeURIComponent(key)}`;
  const res = await fetchWithTimeout(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const mediaUrl = await extractBestMediaUrl(html, origin);
  if (!mediaUrl) throw new Error("MEDIA_NOT_FOUND");

  cache.set(cacheKey, { url: mediaUrl, ts: now });
  return mediaUrl;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "JR_GET_MEDIA") return;

  (async () => {
    const postId = msg.postId;
    if (!postId || !/^\d+$/.test(String(postId))) {
      return { ok: false, error: "BAD_POST_ID" };
    }
    // Домен берём из вкладки, откуда пришло сообщение (несколько зеркал сайта —
    // одно может не отвечать), но только из разрешённого списка, а не любой.
    const senderOrigin = _sender?.url ? new URL(_sender.url).origin : null;
    const origin = ALLOWED_ORIGINS.includes(senderOrigin) ? senderOrigin : ALLOWED_ORIGINS[0];

    try {
      const url = await getMediaLinkForPost(postId, origin);
      return { ok: true, url };
    } catch (e) {
      const reason = e?.name === "AbortError" ? "TIMEOUT" : String(e?.message || e);
      return { ok: false, error: reason };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));

  return true; // keep sendResponse async
});
