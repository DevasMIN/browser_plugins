// YouTube Subscriptions helper
// 1) Скрывает видео от заданных каналов (включая коллабы)
// 2) При каждом входе на /feed/subscriptions проверяет, что подписка
//    на ключевые каналы (сейчас WorkshopCinemaHD) не слетела.

const DEBUG = false;
const NS = '[YT Subs Helper]';

// Пути в href, по которым однозначно определяем канал (для скрытия видео)
const TARGET_URL_PARTS = [
  '/@WorkshopCinemaHD',
  '/channel/UCbd7vzvz5wFe7r_KaW5tQUw', // FRESH Trailers
  '/@FRESHTrailers',
  '/channel/UCEScTo5Hk1YXsCqGW1zgQEw', // топКино
  '/@KinoCheck.com',
  '/channel/UCOL10n-as9dXO2qtjjFUQbQ', // KinoCheck.com
  '/@dimagavr',
];
const TARGET_URL_PARTS_LC = TARGET_URL_PARTS.map((p) => p.toLowerCase());

// Маркеры в тексте карточки (в нижнем регистре)
const TARGET_TEXT_MARKERS = [
  'workshopcinemahd',
  'workshop cinema hd',
  'fresh trailers',
  'freshtrailers',
  '@freshtrailers',
  'топкино',
  'kinocheck.com',
  'kinocheck',
  'dimagavr',
  '@dimagavr',
  'дима гавр',
];

// Маркеры во внутренних данных web‑компонентов (для старых Polymer-карточек;
// новые yt-lockup-view-model не имеют __data — их ловим по href/тексту).
const TARGET_META_MARKERS = [
  '@WorkshopCinemaHD',
  'WorkshopCinemaHD',
  'Workshop Cinema HD',
  'UCbd7vzvz5wFe7r_KaW5tQUw',
  'UCEScTo5Hk1YXsCqGW1zgQEw',
  'FRESH Trailers',
  '@FRESHTrailers',
  'топКино',
  '@KinoCheck.com',
  'KinoCheck.com',
  'KinoCheck',
  'UCOL10n-as9dXO2qtjjFUQbQ',
  '@dimagavr',
  'dimagavr',
];
const HIDDEN_CLASS = 'yt-hide-workshopcinemahd';

// Карточка видео: старые ytd-* рендереры и новые view-model компоненты.
const CARD_SELECTOR = [
  'ytd-rich-item-renderer',
  'yt-lockup-view-model',
  'ytd-video-renderer',
  'ytd-grid-video-renderer',
].join(', ');
// Верхний контейнер элемента сетки — скрываем его, чтобы не было дыр.
const ROW_SELECTOR = 'ytd-rich-item-renderer, ytd-rich-grid-row';
const STATUS_CONTAINER_ID = 'yt-important-subs-status';

/** Троттлинг полного перескана ленты (мс). */
const RESCAN_THROTTLE_MS = 400;

// Каналы, за подпиской на которые нужно следить
const IMPORTANT_CHANNELS = [
  {
    name: 'WorkshopCinemaHD',
    url: 'https://www.youtube.com/@WorkshopCinemaHD',
  },
];

function log(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(NS, ...args);
}

function isOnSubscriptionsPage() {
  return location.pathname === '/feed/subscriptions';
}

function isOnImportantChannelPage() {
  const href = window.location.href;
  return IMPORTANT_CHANNELS.some((ch) => href.startsWith(ch.url));
}

function injectStyles() {
  if (document.documentElement.dataset.ytHideWorkshopCinemaHdStyles) return;
  document.documentElement.dataset.ytHideWorkshopCinemaHdStyles = '1';

  const style = document.createElement('style');
  style.textContent = `
    .${HIDDEN_CLASS} {
      display: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
  `;
  document.documentElement.appendChild(style);
}

// Ограниченный обход вместо JSON.stringify: полный stringify по __data ломал
// главный поток при частых мутациях и лента переставала подгружаться.
const META_WALK_MAX_DEPTH = 5;
const META_WALK_MAX_KEYS = 48;
const META_WALK_MAX_ARRAY = 40;

function objectContainsAnyMarker(value, markers, depth) {
  if (depth <= 0) return false;
  if (value == null) return false;
  const t = typeof value;
  if (t === 'string') {
    for (let i = 0; i < markers.length; i++) {
      if (value.includes(markers[i])) return true;
    }
    return false;
  }
  if (t !== 'object') return false;
  if (Array.isArray(value)) {
    const n = Math.min(value.length, META_WALK_MAX_ARRAY);
    for (let i = 0; i < n; i++) {
      if (objectContainsAnyMarker(value[i], markers, depth - 1)) return true;
    }
    return false;
  }
  try {
    const keys = Object.keys(value);
    const n = Math.min(keys.length, META_WALK_MAX_KEYS);
    for (let i = 0; i < n; i++) {
      if (objectContainsAnyMarker(value[keys[i]], markers, depth - 1)) return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

/** Проверяет, относится ли карточка к одному из целевых каналов. */
function cardMatchesTarget(card) {
  // 1) По href любых ссылок внутри карточки
  const links = card.querySelectorAll('a[href]');
  for (const link of links) {
    const href = (link.getAttribute('href') || '').toLowerCase();
    if (!href) continue;
    for (const part of TARGET_URL_PARTS_LC) {
      if (href.includes(part)) return true;
    }
  }

  // 2) По видимому тексту (имя канала на карточке)
  const text = (card.textContent || '').toLowerCase();
  if (text) {
    for (const marker of TARGET_TEXT_MARKERS) {
      if (text.includes(marker)) return true;
    }
  }

  // 3) По внутренним данным Polymer-компонента (если ещё есть)
  try {
    const possibleData = [
      card.data,
      card.__data,
      card.__data && card.__data.data,
      card.__data && card.__data.hostElement && card.__data.hostElement.data,
    ];
    for (const d of possibleData) {
      if (!d) continue;
      if (objectContainsAnyMarker(d, TARGET_META_MARKERS, META_WALK_MAX_DEPTH)) {
        return true;
      }
    }
  } catch (e) {
    // игнорируем ошибки обхода
  }

  return false;
}

/**
 * Полный перескан ленты. YouTube переиспользует DOM-узлы при подгрузке
 * (перепривязывает данные к существующим карточкам без добавления узлов),
 * поэтому скрытие работает как переключение: несоответствующие карточки
 * размаскировываются — иначе переиспользованная карточка «съедает» чужое
 * видео и лента выглядит обрубленной.
 */
function rescanFeed() {
  if (!isOnSubscriptionsPage()) return;

  const cards = document.querySelectorAll(CARD_SELECTOR);
  const outerStates = new Map();

  cards.forEach((card) => {
    if (!(card instanceof HTMLElement)) return;
    const outer = card.closest(ROW_SELECTOR) || card;
    if (!(outer instanceof HTMLElement)) return;

    const matches = cardMatchesTarget(card);
    // Один outer может содержать несколько карточек — скрываем, если совпала любая.
    outerStates.set(outer, (outerStates.get(outer) || false) || matches);
  });

  outerStates.forEach((shouldHide, outer) => {
    const isHidden = outer.classList.contains(HIDDEN_CLASS);
    if (shouldHide && !isHidden) {
      outer.classList.add(HIDDEN_CLASS);
      log('hide card', outer);
    } else if (!shouldHide && isHidden) {
      outer.classList.remove(HIDDEN_CLASS);
      log('unhide recycled card', outer);
    }
  });
}

let rescanTimer = null;
let lastRescanAt = 0;

function scheduleRescan() {
  if (rescanTimer !== null) return;
  const elapsed = Date.now() - lastRescanAt;
  const delay = Math.max(0, RESCAN_THROTTLE_MS - elapsed);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    lastRescanAt = Date.now();
    rescanFeed();
  }, delay);
}

// Наблюдаем постоянно: ловим и добавление узлов, и перепривязку данных
// к существующим карточкам (меняются текст и атрибуты ссылок).
const observer = new MutationObserver(() => {
  if (!isOnSubscriptionsPage()) return;
  scheduleRescan();
});

function startObserver() {
  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  } catch (e) {
    // ignore
  }
}

function ensureStatusContainer() {
  let box = document.getElementById(STATUS_CONTAINER_ID);
  if (box && box instanceof HTMLElement) return box;

  box = document.createElement('div');
  box.id = STATUS_CONTAINER_ID;
  box.style.position = 'fixed';
  box.style.top = '72px';
  box.style.right = '16px';
  box.style.zIndex = '9999';
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.gap = '4px';
  box.style.fontSize = '12px';
  box.style.fontFamily = 'Roboto, Arial, sans-serif';
  box.style.pointerEvents = 'none';

  document.documentElement.appendChild(box);
  return box;
}

function showSubscriptionStatus(channelName, status) {
  const box = ensureStatusContainer();

  const line = document.createElement('div');
  line.textContent =
    status === true
      ? `✓ Подписка на ${channelName} активна`
      : status === false
      ? `⚠ ПОДПИСКА НА ${channelName} СЛЕТЕЛА`
      : `? Не удалось проверить подписку на ${channelName}`;

  line.style.padding = '4px 8px';
  line.style.borderRadius = '6px';
  line.style.color = '#fff';
  line.style.background =
    status === true ? 'rgba(46,125,50,0.9)' : status === false ? 'rgba(198,40,40,0.95)' : 'rgba(66,66,66,0.9)';
  line.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
  line.style.pointerEvents = 'auto';

  box.appendChild(line);

  setTimeout(() => line.remove(), 6000);
}

async function checkChannelSubscription(channel) {
  try {
    const res = await fetch(channel.url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const html = await res.text();

    // Попробуем вытащить channelId, если его ещё нет
    if (!channel.id) {
      const idMatch = html.match(/\"channelId\":\"([^\"]+)\"/);
      if (idMatch && idMatch[1]) {
        channel.id = idMatch[1];
      }
    }

    // Очень грубая эвристика: на странице канала ищем маркер \"subscribed\":true/false
    if (html.includes('"subscribed":true')) return true;
    if (html.includes('"subscribed":false')) return false;
    return null;
  } catch (e) {
    return null;
  }
}

function getInnertubeConfig() {
  try {
    const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    if (!cfg) return null;

    const apiKey = cfg.get('INNERTUBE_API_KEY');
    const context = cfg.get('INNERTUBE_CONTEXT');
    const clientName =
      (context && context.client && context.client.clientName) || cfg.get('INNERTUBE_CLIENT_NAME');
    const clientVersion =
      (context && context.client && context.client.clientVersion) || cfg.get('INNERTUBE_CLIENT_VERSION');

    if (!apiKey || !context) return null;

    return { apiKey, context, clientName, clientVersion };
  } catch (e) {
    return null;
  }
}

async function subscribeIfNeeded(channel) {
  const status = await checkChannelSubscription(channel);

  // Уже подписаны или не удалось понять статус
  if (status === true || status === null) {
    showSubscriptionStatus(channel.name, status);
    return;
  }

  // status === false — попробуем подписаться программно
  const cfg = getInnertubeConfig();
  if (!cfg || !channel.id) {
    showSubscriptionStatus(channel.name, false);
    return;
  }

  try {
    const res = await fetch(
      `/youtubei/v1/subscription/subscribe?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': String(cfg.clientName || ''),
          'X-Youtube-Client-Version': String(cfg.clientVersion || ''),
        },
        body: JSON.stringify({
          context: cfg.context,
          channelIds: [channel.id],
        }),
      }
    );

    if (res.ok) {
      showSubscriptionStatus(channel.name, true);
    } else {
      showSubscriptionStatus(channel.name, false);
    }
  } catch (e) {
    showSubscriptionStatus(channel.name, false);
  }
}

function initChannelAutoSubscribe() {
  let attempts = 0;

  function tryClick() {
    const button =
      document.querySelector('yt-subscribe-button-view-model button.yt-spec-button-shape-next') ||
      document.querySelector('button[aria-label*="Оформить подписку на канал"]') ||
      document.querySelector('button[aria-label*="Subscribe to"]');

    if (!button) {
      if (attempts++ < 40) {
        setTimeout(tryClick, 300);
      }
      return;
    }

    const label = (button.getAttribute('aria-label') || button.textContent || '').toLowerCase();
    const isAlreadySub =
      label.includes('вы подписаны') ||
      label.includes('subscribed') ||
      label.includes('unsubscribe');

    if (isAlreadySub) {
      return;
    }

    const shouldClick = label.includes('подписаться') || label.includes('subscribe');
    if (shouldClick) {
      button.click();
    }
  }

  tryClick();
}

function onPageActivated() {
  if (isOnSubscriptionsPage()) {
    scheduleRescan();
    log('activated on subscriptions');
  } else if (isOnImportantChannelPage()) {
    initChannelAutoSubscribe();
    log('activated on important channel');
  }
}

// Инициализируемся на любой странице YouTube: пользователь часто попадает
// в ленту подписок SPA-переходом с главной, без перезагрузки страницы.
function init() {
  injectStyles();
  startObserver();

  window.addEventListener('yt-navigate-finish', onPageActivated);
  window.addEventListener('yt-page-data-updated', onPageActivated);

  onPageActivated();
  log('init');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
