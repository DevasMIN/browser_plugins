// Полифил для совместимости Firefox и Chrome
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Service worker для фоновых задач
browserAPI.runtime.onInstalled.addListener(() => {});

// Обработка команд с клавиатуры (если нужно)
if (browserAPI.commands) {
    browserAPI.commands.onCommand.addListener(() => {});
}

// Обновление badge на иконке расширения (стандартный Firefox badge)
async function updateBadge(speed, tabId) {
    try {
        if (!browserAPI.browserAction) return;
        
        const speedText = speed === 1.0 ? '' : speed.toFixed(1);
        if (typeof tabId !== 'number') {
            return;
        }
        await browserAPI.browserAction.setBadgeText({ text: speedText, tabId });
        await browserAPI.browserAction.setBadgeBackgroundColor({ color: '#2196F3', tabId });
        
        if (browserAPI.browserAction.setBadgeTextColor) {
            await browserAPI.browserAction.setBadgeTextColor({ color: '#000000', tabId });
        }
    } catch (e) {
        // Игнорируем ошибки badge
    }
}

// Обработка сообщений от content script и popup
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'updateBadge') {
            const senderTabId = sender && sender.tab ? sender.tab.id : undefined;
            updateBadge(request.speed, senderTabId);
            sendResponse({ success: true });
        }
    } catch (error) {
        // Игнорируем ошибки
    }
    return true;
});

browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
        browserAPI.tabs.sendMessage(tabId, { action: 'applySavedSpeed' })
            .catch(() => {
                // Контентный скрипт ещё не готов, пропускаем
            });
    }
});
