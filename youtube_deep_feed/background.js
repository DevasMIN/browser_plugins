// Переписываем Origin/Referer на youtube.com для запросов расширения к
// внутреннему API. YouTube проверяет Origin; со страницы расширения он
// `chrome-extension://…` и API отвечает 403. Правило действует только на
// third-party запросы (наши), собственные страницы YouTube не затрагивает —
// поэтому прямой fetch работает и обходная вкладка-реле не нужна.
const DNR_RULE = {
  id: 1,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
      { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
    ],
  },
  condition: {
    urlFilter: '||youtube.com/youtubei/',
    resourceTypes: ['xmlhttprequest'],
    domainType: 'thirdParty',
  },
};

async function installDnrRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE.id],
      addRules: [DNR_RULE],
    });
  } catch (e) {
    console.warn('DNR rule install failed', e);
  }
}

chrome.runtime.onInstalled.addListener(installDnrRule);
chrome.runtime.onStartup.addListener(installDnrRule);
installDnrRule();

// Открывает (или активирует уже открытую) страницу ленты
async function openFeed() {
  const url = chrome.runtime.getURL('feed.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(openFeed);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-feed') openFeed();
});
