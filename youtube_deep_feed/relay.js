// Реле: выполняет запросы к внутреннему API YouTube из контекста вкладки
// youtube.com. Нужен, потому что со страницы расширения Chrome не отправляет
// авторизационные куки (SameSite) и API отвечает 403.

let cfgCache = null;

/** API-ключ и версия клиента: из инлайн-скриптов страницы или свежего HTML. */
async function getCfg() {
  if (cfgCache) return cfgCache;
  let src = '';
  for (const s of document.scripts) {
    if (s.textContent && s.textContent.includes('INNERTUBE_API_KEY')) {
      src = s.textContent;
      break;
    }
  }
  if (!src) {
    const r = await fetch('/?hl=ru', { credentials: 'same-origin' });
    src = await r.text();
  }
  const key = src.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = src.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
  if (!key || !ver) throw new Error('Не найдена конфигурация innertube на странице');
  cfgCache = { key, ver };
  return cfgCache;
}

async function sapisidHash() {
  const m =
    document.cookie.match(/(?:^|; )SAPISID=([^;]+)/) ||
    document.cookie.match(/(?:^|; )__Secure-3PAPISID=([^;]+)/);
  if (!m) return null;
  const ts = Math.floor(Date.now() / 1000);
  const raw = `${ts} ${m[1]} https://www.youtube.com`;
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

const ALLOWED_ENDPOINTS = ['browse', 'browse/edit_playlist', 'feedback'];

async function doApi(endpoint, body) {
  if (!ALLOWED_ENDPOINTS.includes(endpoint)) throw new Error(`endpoint не разрешён: ${endpoint}`);
  const cfg = await getCfg();
  const auth = await sapisidHash();
  const headers = { 'Content-Type': 'application/json', 'X-Origin': 'https://www.youtube.com' };
  if (auth) headers['Authorization'] = auth;
  const r = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${cfg.key}&prettyPrint=false`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: cfg.ver, hl: 'ru', gl: 'RU' } },
      ...body,
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'api') {
    (async () => {
      try {
        sendResponse({ ok: true, json: await doApi(msg.endpoint, msg.body) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // асинхронный sendResponse
  }
});
