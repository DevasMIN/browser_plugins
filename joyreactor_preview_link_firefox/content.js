/* global chrome */

const api = typeof browser !== "undefined" ? browser : chrome;

const BTN_CLASS = "jr-mp4-btn";
const STYLE_ID = "jr-mp4-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${BTN_CLASS} {
      appearance: none;
      border: 0;
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
      font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: #fff;
      background: rgba(30, 144, 255, 0.92);
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      user-select: none;
      white-space: nowrap;
    }
    .${BTN_CLASS}[data-variant="inline"] {
      padding: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      color: inherit;
      font: inherit;
      text-transform: none;
      text-decoration: underline;
      opacity: 0.9;
    }
    .${BTN_CLASS}[data-variant="inline"]:hover { opacity: 1; background: transparent; }
    .${BTN_CLASS}[data-variant="mini"] {
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 11px;
      background: rgba(30, 144, 255, 0.85);
    }
    .${BTN_CLASS}:hover { background: rgba(24, 119, 255, 0.95); }
    .${BTN_CLASS}:active { transform: translateY(1px); }
    .${BTN_CLASS}[disabled] { opacity: 0.6; cursor: default; }
    .jr-mp4-toast {
      position: fixed;
      z-index: 2147483647;
      left: 12px;
      bottom: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(20,20,20,0.92);
      color: #fff;
      font: 13px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      max-width: min(520px, calc(100vw - 24px));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  document.documentElement.appendChild(style);
}

function toast(text, timeoutMs = 1800) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "jr-mp4-toast";
  el.textContent = text;
  document.documentElement.appendChild(el);
  window.setTimeout(() => el.remove(), timeoutMs);
}

function extractPostIdFromUrl(urlString) {
  try {
    const u = new URL(urlString, location.href);
    const m = u.pathname.match(/\/post\/(\d+)/);
    return m?.[1] || null;
  } catch {
    return null;
  }
}

function getCurrentPostId() {
  return extractPostIdFromUrl(location.href);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older/locked clipboard
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function createButton({ postId, variant }) {
  ensureStyles();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.dataset.variant = variant || "normal";
  btn.textContent = variant === "inline" ? "mp4" : "MP4";
  btn.title = "Скопировать прямую ссылку на mp4 для Telegram";

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const id = postId || getCurrentPostId();
    if (!id) {
      toast("Не найден ID поста");
      return;
    }

    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "...";

    try {
      const resp = await api.runtime.sendMessage({ type: "JR_GET_MEDIA", postId: id });
      if (!resp?.ok || !resp?.url) {
        throw new Error(resp?.error || "UNKNOWN_ERROR");
      }

      const ok = await copyText(resp.url);
      if (ok) toast(`Ссылка скопирована: ${resp.url}`);
      else toast(`Ссылка: ${resp.url}`);
    } catch (err) {
      toast(`Ошибка: ${String(err?.message || err)}`);
    } finally {
      btn.textContent = prev;
      btn.disabled = false;
    }
  });

  return btn;
}

function findFirstLinkByText(text) {
  const target = String(text).trim().toLowerCase();
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const t = (a.textContent || "").trim().toLowerCase();
    if (t === target) return a;
  }
  return null;
}

function findSharedContainer(a, b) {
  if (!a || !b) return null;
  const seen = new Set();
  let p = a;
  while (p) {
    seen.add(p);
    p = p.parentElement;
  }
  p = b;
  while (p) {
    if (seen.has(p)) return p;
    p = p.parentElement;
  }
  return null;
}

function injectButtonNearLinkAndHide() {
  try {
    const postId = getCurrentPostId();
    if (!postId) return false;
    if (document.querySelector(`.${BTN_CLASS}[data-inline="1"]`)) return true;

    const linkA = findFirstLinkByText("ссылка");
    const hideA = findFirstLinkByText("скрыть");
    const container = findSharedContainer(linkA, hideA) || linkA?.parentElement || hideA?.parentElement;
    if (!container) return false;

    const btn = createButton({ postId, variant: "inline" });
    btn.dataset.inline = "1";

    // Insert between "ссылка" and "скрыть" if both exist in same container
    if (linkA && hideA && container.contains(linkA) && container.contains(hideA)) {
      hideA.insertAdjacentText("beforebegin", " ");
      hideA.insertAdjacentElement("beforebegin", btn);
      hideA.insertAdjacentText("beforebegin", " ");
    } else {
      container.appendChild(document.createTextNode(" "));
      container.appendChild(btn);
    }
    return true;
  } catch {
    return false;
  }
}

function injectFloatingButtonOnPostPage() {
  const postId = getCurrentPostId();
  if (!postId) return;

  // Prefer inline placement near "ссылка / скрыть"
  if (injectButtonNearLinkAndHide()) return;

  if (document.querySelector(`.${BTN_CLASS}[data-floating="1"]`)) return;

  const btn = createButton({ postId, variant: "normal" });
  btn.dataset.floating = "1";
  btn.style.position = "fixed";
  btn.style.zIndex = "2147483647";
  btn.style.right = "12px";
  btn.style.bottom = "12px";
  document.documentElement.appendChild(btn);
}

function enhanceFeedMedia() {
  // Try to place a small MP4 button on media blocks in the feed.
  // We don't rely on exact JoyReactor markup: detect images/videos and find nearest /post/<id> link.
  const mediaNodes = Array.from(document.querySelectorAll("img, video"));
  for (const media of mediaNodes) {
    if (!(media instanceof HTMLElement)) continue;
    if (media.dataset.jrMp4Enhanced === "1") continue;

    const container = media.closest("a") || media.closest("div") || media.parentElement;
    if (!container) continue;

    // Find post id nearby
    let postId = null;
    const nearLink =
      container.closest("a[href*='/post/']") ||
      container.querySelector?.("a[href*='/post/']") ||
      media.closest("div")?.querySelector?.("a[href*='/post/']");

    if (nearLink && nearLink.getAttribute) {
      postId = extractPostIdFromUrl(nearLink.getAttribute("href") || "");
    }
    if (!postId) continue;

    // Create mini overlay button near media
    const wrapper = media.parentElement;
    if (!wrapper) continue;

    // Ensure wrapper can host absolutely-positioned overlay
    const computed = window.getComputedStyle(wrapper);
    if (computed.position === "static") wrapper.style.position = "relative";

    if (wrapper.querySelector(`.${BTN_CLASS}[data-post-id='${postId}']`)) {
      media.dataset.jrMp4Enhanced = "1";
      continue;
    }

    const btn = createButton({ postId, variant: "mini" });
    btn.dataset.postId = postId;
    btn.style.position = "absolute";
    btn.style.left = "8px";
    btn.style.top = "8px";
    btn.style.zIndex = "10";

    wrapper.appendChild(btn);
    media.dataset.jrMp4Enhanced = "1";
  }
}

function init() {
  injectFloatingButtonOnPostPage();
  enhanceFeedMedia();

  // Re-scan on dynamic updates
  const mo = new MutationObserver(() => {
    injectFloatingButtonOnPostPage();
    enhanceFeedMedia();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

init();

