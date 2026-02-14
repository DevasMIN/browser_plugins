/* global chrome */

const api = typeof browser !== "undefined" ? browser : chrome;

const CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { url: string, ts: number }>} */
const cache = new Map();

function pickFirstMatch(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[0]) return m[0];
  }
  return null;
}

function normalizeToAbsolute(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://joyreactor.cc${url}`;
  return null;
}

function deriveMp4FromWebm(webmUrl) {
  if (!webmUrl) return null;
  try {
    const u = new URL(webmUrl);
    u.pathname = u.pathname.replace(/\/webm\//i, "/mp4/").replace(/\.webm$/i, ".mp4");
    return u.toString();
  } catch {
    // Best effort for relative paths
    if (webmUrl.startsWith("/")) {
      return `https://joyreactor.cc${webmUrl.replace(/\/webm\//i, "/mp4/").replace(/\.webm$/i, ".mp4")}`;
    }
    return null;
  }
}

async function urlExists(url) {
  try {
    const head = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit" });
    if (head.ok) return true;
  } catch {
    // ignore
  }

  try {
    const get = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
    return get.ok;
  } catch {
    return false;
  }
}

async function extractBestMediaUrl(html) {
  // Prefer MP4 (Telegram preview-friendly)
  const mp4Raw = pickFirstMatch(html, [
    /https?:\/\/img\d+\.joyreactor\.cc\/pics\/post\/mp4\/[^"'\\\s>]+\.mp4/iu,
    /\/pics\/post\/mp4\/[^"'\\\s>]+\.mp4/iu,
  ]);
  const mp4 = normalizeToAbsolute(mp4Raw);
  if (mp4) return mp4;

  // Fallback: WEBM exists on some posts; try to derive MP4 sibling if present.
  const webmRaw = pickFirstMatch(html, [
    /https?:\/\/img\d+\.joyreactor\.cc\/pics\/post\/webm\/[^"'\\\s>]+\.webm/iu,
    /\/pics\/post\/webm\/[^"'\\\s>]+\.webm/iu,
  ]);
  const webm = normalizeToAbsolute(webmRaw);
  if (!webm) return null;

  const derivedMp4 = deriveMp4FromWebm(webm);
  if (derivedMp4 && (await urlExists(derivedMp4))) return derivedMp4;

  return webm;
}

async function getMediaLinkForPost(postId) {
  const key = String(postId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.url;

  const url = `https://joyreactor.cc/post/${encodeURIComponent(key)}`;
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const mediaUrl = await extractBestMediaUrl(html);
  if (!mediaUrl) throw new Error("MEDIA_NOT_FOUND");

  cache.set(key, { url: mediaUrl, ts: now });
  return mediaUrl;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "JR_GET_MEDIA") return;

  (async () => {
    const postId = msg.postId;
    if (!postId || !/^\d+$/.test(String(postId))) {
      return { ok: false, error: "BAD_POST_ID" };
    }

    try {
      const url = await getMediaLinkForPost(postId);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));

  return true; // keep sendResponse async
});

