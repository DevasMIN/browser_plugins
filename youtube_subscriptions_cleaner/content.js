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
  '/channel/UCEScTo5Hk1YXsCqGW1zgQEw', // топКино
];

// Маркеры в тексте карточки
const TARGET_TEXT_MARKERS = [
  'workshopcinemahd',
  'workshop cinema hd',
  'fresh trailers',
  'freshtrailers',
  'топкино',
];

// Маркеры во внутренних данных web‑компонентов
const TARGET_META_MARKERS = [
  '@WorkshopCinemaHD',
  'WorkshopCinemaHD',
  'Workshop Cinema HD',
  'UCbd7vzvz5wFe7r_KaW5tQUw',
  'UCEScTo5Hk1YXsCqGW1zgQEw',
  'FRESH Trailers',
  'топКино',
];
const HIDDEN_CLASS = 'yt-hide-workshopcinemahd';
const CARD_SELECTOR =
  'ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-grid-video-renderer';
const ROW_SELECTOR = 'ytd-rich-item-renderer, ytd-rich-grid-row';
const STATUS_CONTAINER_ID = 'yt-important-subs-status';

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

function getCardElementFromLink(link) {
  const innerCard = link.closest(CARD_SELECTOR);
  if (!innerCard) return null;

  // Поднимаемся до верхнего контейнера строки/карточки,
  // чтобы не оставлять пустых чёрных полос.
  const outerCard = innerCard.closest(ROW_SELECTOR) || innerCard;
  if (!(outerCard instanceof HTMLElement)) return null;
  return outerCard;
}

function hideCardsForChannel(root) {
  if (!root || !root.querySelectorAll) return;

  // 1) По href: любые ссылки, ведущие на целевые каналы
  TARGET_URL_PARTS.forEach((part) => {
    const links = root.querySelectorAll(`a[href*="${part}"]`);
    links.forEach((link) => {
      const card = getCardElementFromLink(link);
      if (!card) return;

      if (!card.classList.contains(HIDDEN_CLASS)) {
        card.classList.add(HIDDEN_CLASS);
        log('hide card by link', part, card);
      }
    });
  });

  // Дополнительно ловим коллаборации, где handle может не быть в href,
  // но есть в тексте карточки или во внутренних данных компонента.
  const cards = root.querySelectorAll(CARD_SELECTOR);
  cards.forEach((card) => {
    if (!(card instanceof HTMLElement) || card.classList.contains(HIDDEN_CLASS)) return;

    let shouldHide = false;

    // 1) По видимому тексту
    const text = (card.textContent || '').toLowerCase();
    if (text) {
      for (const marker of TARGET_TEXT_MARKERS) {
        if (text.includes(marker)) {
          shouldHide = true;
          break;
        }
      }
    }

    // 2) По внутренним данным web‑компонента (__data / data)
    if (!shouldHide) {
      try {
        const possibleData = [
          card.data,
          card.__data,
          card.__data && card.__data.data,
          card.__data && card.__data.hostElement && card.__data.hostElement.data,
        ];
        for (const d of possibleData) {
          if (!d) continue;
          const s = JSON.stringify(d);
          for (const marker of TARGET_META_MARKERS) {
            if (s.includes(marker)) {
              shouldHide = true;
              break;
            }
          }
          if (shouldHide) break;
        }
      } catch (e) {
        // игнорируем любые ошибки сериализации
      }
    }

    if (shouldHide) {
      const outer = card.closest(ROW_SELECTOR) || card;
      if (outer instanceof HTMLElement) {
        outer.classList.add(HIDDEN_CLASS);
        log('hide card by meta', outer);
      }
    }
  });
}

const observer = new MutationObserver((mutations) => {
  if (!isOnSubscriptionsPage()) return;

  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      hideCardsForChannel(node);
    });
  });
});

function startObserver() {
  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
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

    setTimeout(() => {
      try {
        window.close();
      } catch (e) {}
    }, 2000);
  }

  tryClick();
}

function init() {
  if (isOnSubscriptionsPage()) {
    injectStyles();
    hideCardsForChannel(document);
    startObserver();

    window.addEventListener('yt-navigate-finish', () => {
      if (!isOnSubscriptionsPage()) return;
      hideCardsForChannel(document);
    });

    log('init on subscriptions');
  } else if (isOnImportantChannelPage()) {
    initChannelAutoSubscribe();
    log('init on important channel');
  } else {
    log('not target page, idle');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
