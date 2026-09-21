// Полифил для совместимости Firefox и Chrome
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Переписываем Origin/Referer на youtube.com для запросов расширения к
// внутреннему API. YouTube проверяет Origin; со страницы расширения он
// `moz-extension://…` и API отвечает 403. В Chrome-версии для этого
// используется declarativeNetRequest, но его поддержка «сессионных» правил в
// Firefox ненадёжна — вместо этого используем классический блокирующий
// webRequest (Firefox продолжает поддерживать его и в MV3 через
// webRequestBlocking). Правило действует только на запросы из самого
// расширения, свои страницы YouTube (и вкладка-реле в их контексте) не
// затрагивает.
const EXTENSION_ORIGIN = browserAPI.runtime.getURL('').slice(0, -1); // без хвостового '/'

function isFromExtension(details) {
  const origin = details.originUrl || details.documentUrl || '';
  return origin.startsWith(EXTENSION_ORIGIN);
}

function rewriteHeaders(details) {
  if (!isFromExtension(details)) return {};
  const headers = details.requestHeaders || [];
  const setHeader = (name, value) => {
    const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (h) h.value = value;
    else headers.push({ name, value });
  };
  setHeader('Origin', 'https://www.youtube.com');
  setHeader('Referer', 'https://www.youtube.com/');
  return { requestHeaders: headers };
}

if (browserAPI.webRequest && browserAPI.webRequest.onBeforeSendHeaders) {
  browserAPI.webRequest.onBeforeSendHeaders.addListener(
    rewriteHeaders,
    { urls: ['https://www.youtube.com/youtubei/*'], types: ['xmlhttprequest'] },
    ['blocking', 'requestHeaders']
  );
}

// Открывает (или активирует уже открытую) страницу ленты
async function openFeed() {
  const url = browserAPI.runtime.getURL('feed.html');
  const tabs = await browserAPI.tabs.query({ url });
  if (tabs.length) {
    await browserAPI.tabs.update(tabs[0].id, { active: true });
    await browserAPI.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browserAPI.tabs.create({ url });
  }
}

browserAPI.action.onClicked.addListener(openFeed);
browserAPI.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-feed') openFeed();
});
