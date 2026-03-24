// Дефолтные пресеты
const DEFAULT_PRESETS = [
    [25, 50, 75],
    [90, 100, 110],
    [125, 150, 175],
    [200, 250, 1600]
];

let currentPresets = [];
let currentEditingIndex = null;
let isEnabled = true;
let currentScope = 'tab';
let currentMessages = null; // null = use chrome.i18n
let activeTabId = null;

function applyScopeToUi(scope) {
    const normalizedScope = ['tab', 'domain', 'all'].includes(scope) ? scope : 'all';
    currentScope = normalizedScope;
    const scopeInput = document.querySelector(`input[name="scope"][value="${normalizedScope}"]`);
    if (scopeInput) {
        scopeInput.checked = true;
    }
}

// Загрузить переводы из _locales/{locale}/messages.json
async function loadLocale(locale) {
    try {
        const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
        const res = await fetch(url);
        const json = await res.json();
        const messages = {};
        for (const [key, obj] of Object.entries(json)) {
            if (obj && obj.message) messages[key] = obj.message;
        }
        return messages;
    } catch (e) {
        return null;
    }
}

// Функция для применения переводов (messages = null → chrome.i18n)
function applyI18n(messages = null) {
    currentMessages = messages;
    const getMsg = (key) => {
        if (messages && messages[key]) return messages[key];
        return chrome.i18n.getMessage(key) || '';
    };

    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const text = getMsg(key);
        if (text) element.textContent = text;
    });

    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        const text = getMsg(key);
        if (text) element.title = text;
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        const text = getMsg(key);
        if (text) element.placeholder = text;
    });
}

function getMessage(key) {
    if (currentMessages && currentMessages[key]) return currentMessages[key];
    return chrome.i18n.getMessage(key) || '';
}

function setActiveLangButton() {
    chrome.storage.local.get(['preferredLocale'], (result) => {
        const locale = result.preferredLocale || 'ru';
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === locale);
        });
    });
}

// Инициализация
async function init() {
    const result = await chrome.storage.local.get(['preferredLocale']);
    const locale = result.preferredLocale || 'ru';
    const messages = await loadLocale(locale);
    applyI18n(messages);
    setActiveLangButton();

    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const lang = btn.getAttribute('data-lang');
            await chrome.storage.local.set({ preferredLocale: lang });
            const msgs = await loadLocale(lang);
            applyI18n(msgs);
            setActiveLangButton();
            updateShortcutsList();
        });
    });

    await loadSettings();
    renderPresets();
    setupEventListeners();
    updateVideoInfo();
    setInterval(updateVideoInfo, 1000);
    
    // Загружаем текущую скорость при открытии popup
    setTimeout(async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id && isScriptableUrl(tab.url)) {
                activeTabId = tab.id;
                try {
                    chrome.tabs.sendMessage(tab.id, { action: 'getEffectiveSpeed' }, (response) => {
                        // Проверяем lastError только если он есть
                        if (chrome.runtime.lastError) {
                            const errorMsg = chrome.runtime.lastError.message || '';
                            // Игнорируем ожидаемые ошибки
                            if (errorMsg.includes('Receiving end does not exist') ||
                                errorMsg.includes('Extension context invalidated')) {
                                return;
                            }
                            return;
                        }
                        if (response && typeof response.currentSpeed === 'number') {
                            const speedPercent = Math.round(response.currentSpeed * 100);
                            document.getElementById('currentSpeed').value = speedPercent;
                            updateCurrentSpeedDisplay(response.currentSpeed);
                            updateBadge(response.currentSpeed);
                        }
                        if (response && response.effectiveScope) {
                            applyScopeToUi(response.effectiveScope);
                        }
                    });
                } catch (msgErr) {
                    // Игнорируем ошибки
                }
            }
        } catch (e) {
            // Игнорируем ожидаемые ошибки
            const errorMsg = e.message || e.toString() || '';
            if (errorMsg.includes('Extension context invalidated') ||
                errorMsg.includes('chrome://') ||
                errorMsg.includes('Cannot access')) {
                return;
            }
            // Логируем только неожиданные ошибки
            console.error('Ошибка загрузки текущей скорости:', e);
        }
    }, 100);
}

// Загрузка настроек
async function loadSettings() {
    const result = await chrome.storage.sync.get(['presets', 'enabled', 'scope']);
    currentPresets = result.presets || createDefaultPresets();
    isEnabled = result.enabled !== false;
    currentScope = result.scope || 'tab';
    
    document.getElementById('toggleEnabled').checked = isEnabled;
    applyScopeToUi(currentScope);
}

// Создание дефолтных пресетов
function createDefaultPresets() {
    const presets = [];
    DEFAULT_PRESETS.forEach(row => {
        row.forEach(speed => {
            presets.push({ speed, shortcut: null });
        });
    });
    return presets;
}

// Сохранение настроек
async function saveSettings() {
    await chrome.storage.sync.set({
        presets: currentPresets,
        enabled: isEnabled,
        scope: currentScope
    });
}

// Рендеринг пресетов
function renderPresets() {
    const grid = document.getElementById('presetGrid');
    grid.innerHTML = '';
    
    currentPresets.forEach((preset, index) => {
        const cell = document.createElement('div');
        cell.className = 'preset-cell';
        
        // Основной текст скорости
        const speedLabel = document.createElement('div');
        speedLabel.className = 'preset-speed';
        speedLabel.textContent = `${preset.speed}%`;
        cell.appendChild(speedLabel);
        
        if (preset.shortcut) {
            cell.classList.add('has-shortcut');
            const badge = document.createElement('div');
            badge.className = 'shortcut-badge';
            badge.textContent = preset.shortcut;
            cell.appendChild(badge);
        } else {
            cell.classList.remove('has-shortcut');
        }
        
        const editIcon = document.createElement('span');
        editIcon.className = 'edit-icon';
        editIcon.textContent = '✎';
        cell.appendChild(editIcon);
        
        cell.addEventListener('click', () => {
            if (isEnabled) {
                applySpeed(preset.speed);
            }
        });
        
        editIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditModal(index);
        });
        
        grid.appendChild(cell);
    });
    
    updateShortcutsList();
}

// Проверка доступности URL для выполнения скриптов
function isScriptableUrl(url) {
    if (!url) return false;
    try {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol;
        // Запрещенные протоколы
        return !['chrome:', 'edge:', 'about:', 'moz-extension:', 'chrome-extension:'].includes(protocol);
    } catch (e) {
        return false;
    }
}

// Применение скорости
async function applySpeed(speed) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab || !tab.id) {
            console.error('Не удалось получить активную вкладку');
            return;
        }
        
        // Проверяем доступность URL
        if (!isScriptableUrl(tab.url)) {
            // Тихая проверка - не логируем для chrome:// страниц
            return;
        }
        
        const speedValue = speed / 100;
        
        // Используем sendMessage к content.js для использования защиты от сброса
        try {
            chrome.tabs.sendMessage(tab.id, {
                action: 'setSpeed',
                speed: speedValue,
                scope: currentScope
            }, (response) => {
                // Проверяем lastError
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message || '';
                    // Если content script не отвечает, игнорируем
                    if (!errorMsg.includes('Receiving end does not exist') &&
                        !errorMsg.includes('Extension context invalidated')) {
                        console.error('Ошибка установки скорости:', chrome.runtime.lastError);
                    }
                } else if (response && response.success) {
                    console.log('✅ Скорость успешно установлена через content.js');
                    if (response.currentSpeed) {
                        updateCurrentSpeedDisplay(response.currentSpeed);
                    }
                }
            });
            
            // Всегда обновляем UI
            updateCurrentSpeedDisplay(speedValue);
            updateBadge(speedValue);
        } catch (err) {
            console.error('Ошибка отправки сообщения:', err);
        }
        
        // Обновление активной ячейки
        document.querySelectorAll('.preset-cell').forEach((cell, index) => {
            if (currentPresets[index] && currentPresets[index].speed === speed) {
                cell.classList.add('active');
            } else {
                cell.classList.remove('active');
            }
        });
        
        document.getElementById('currentSpeed').value = speed;
        updateCurrentSpeedDisplay(speedValue);
        updateBadge(speedValue);
    } catch (error) {
        // Игнорируем ожидаемые ошибки
        const errorMsg = error.message || error.toString() || '';
        if (errorMsg.includes('Extension context invalidated') ||
            errorMsg.includes('chrome://') ||
            errorMsg.includes('Cannot access')) {
            return;
        }
        // Логируем только неожиданные ошибки
        console.error('Ошибка применения скорости:', error);
    }
}

// Открытие модального окна редактирования
function openEditModal(index) {
    currentEditingIndex = index;
    const preset = currentPresets[index];
    const modal = document.getElementById('editModal');
    const speedInput = document.getElementById('editSpeed');
    const shortcutInput = document.getElementById('editShortcut');
    
    speedInput.value = preset.speed;
    shortcutInput.value = preset.shortcut || '';
    
    modal.classList.add('show');
    
    // Обработка ввода горячей клавиши
    const handleShortcut = (e) => {
        e.preventDefault();
        const keys = [];
        
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');
        if (e.metaKey) keys.push('Meta');
        
        if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
            keys.push(e.key.toUpperCase());
        }
        
        if (keys.length > 0) {
            shortcutInput.value = keys.join('+');
        }
    };
    
    shortcutInput.addEventListener('keydown', handleShortcut);
    
    // Сохраняем обработчик для последующего удаления
    shortcutInput._shortcutHandler = handleShortcut;
}

// Закрытие модального окна
function closeEditModal() {
    const shortcutInput = document.getElementById('editShortcut');
    if (shortcutInput._shortcutHandler) {
        shortcutInput.removeEventListener('keydown', shortcutInput._shortcutHandler);
        shortcutInput._shortcutHandler = null;
    }
    document.getElementById('editModal').classList.remove('show');
    currentEditingIndex = null;
}

// Сохранение изменений
function saveEdit() {
    if (currentEditingIndex === null) return;
    
    const speed = parseInt(document.getElementById('editSpeed').value);
    const shortcut = document.getElementById('editShortcut').value || null;
    
    if (speed < 25 || speed > 1600) {
        alert('Скорость должна быть от 25% до 1600%');
        return;
    }
    
    currentPresets[currentEditingIndex].speed = speed;
    currentPresets[currentEditingIndex].shortcut = shortcut;
    
    saveSettings();
    renderPresets();
    closeEditModal();
}

// Обновление списка горячих клавиш
function updateShortcutsList() {
    const list = document.getElementById('shortcutsList');
    list.innerHTML = '';
    
    const shortcuts = currentPresets
        .map((preset, index) => ({ ...preset, index }))
        .filter(p => p.shortcut);
    
    if (shortcuts.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color: #999; font-size: 11px;';
        empty.textContent = getMessage('shortcutNone') || 'Нет назначенных горячих клавиш';
        list.appendChild(empty);
        return;
    }
    
    shortcuts.forEach(({ speed, shortcut, index }) => {
        const item = document.createElement('div');
        item.className = 'shortcut-item';
        
        const keyBadge = document.createElement('span');
        keyBadge.className = 'key-badge';
        keyBadge.textContent = shortcut.split('+').pop();
        
        const description = document.createElement('span');
        const setSpeedText = getMessage('shortcutSetSpeed') || 'установить скорость';
        description.textContent = `- ${setSpeedText} ${speed}%`;
        
        item.appendChild(keyBadge);
        item.appendChild(description);
        list.appendChild(item);
    });
}

// Обновление информации о видео
async function updateVideoInfo() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;
        const requestTabId = tab.id;
        activeTabId = requestTabId;
        
        // Проверяем доступность URL
        if (!isScriptableUrl(tab.url)) {
            document.getElementById('currentUrl').textContent = 'N/A';
            document.getElementById('playStatus').textContent = getMessage('playStatus') || '⏸ N/A';
            document.getElementById('currentTime').textContent = '0:00';
            return;
        }
        
        try {
            const url = new URL(tab.url);
            document.getElementById('currentUrl').textContent = url.hostname;
        } catch (e) {
            document.getElementById('currentUrl').textContent = tab.url || '-';
        }
        
        // Используем executeScript для надежного получения информации
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: requestTabId },
                func: () => {
                    const videos = document.querySelectorAll('video');
                    if (videos.length === 0) {
                        return { hasVideo: false, playing: false, currentTime: 0, currentSpeed: 1.0 };
                    }
                    const video = videos[0];
                    return {
                        hasVideo: true,
                        playing: !video.paused,
                        currentTime: video.currentTime || 0,
                        currentSpeed: video.playbackRate || 1.0
                    };
                }
            });
            
            if (results && results[0] && results[0].result) {
                if (requestTabId !== activeTabId) return;
                const info = results[0].result;
                document.getElementById('playStatus').textContent =
                    info.playing ? getMessage('playStatusPlaying') : getMessage('playStatus');
                document.getElementById('currentTime').textContent = formatTime(info.currentTime);
                if (info.hasVideo && typeof info.currentSpeed === 'number') {
                    updateCurrentSpeedDisplay(info.currentSpeed);
                    updateBadge(info.currentSpeed);
                    document.getElementById('currentSpeed').value = Math.round(info.currentSpeed * 100);
                }
            }
        } catch (err) {
            // Игнорируем ожидаемые ошибки
            const errMsg = err.message || err.toString() || '';
            if (errMsg.includes('chrome://') ||
                errMsg.includes('Cannot access') ||
                errMsg.includes('Extension context invalidated')) {
                return;
            }
            // Fallback через sendMessage
            try {
                chrome.tabs.sendMessage(requestTabId, { action: 'getVideoInfo' }, (response) => {
                    if (requestTabId !== activeTabId) return;
                    // Проверяем lastError только если он есть
                    if (chrome.runtime.lastError) {
                        const errorMsg = chrome.runtime.lastError.message || '';
                        // Игнорируем ожидаемые ошибки
                        if (errorMsg.includes('Receiving end does not exist') ||
                            errorMsg.includes('Extension context invalidated')) {
                            return;
                        }
                    }
                    if (response) {
                        document.getElementById('playStatus').textContent =
                            response.playing ? getMessage('playStatusPlaying') : getMessage('playStatus');
                        document.getElementById('currentTime').textContent = formatTime(response.currentTime);
                        if (response.hasVideo && typeof response.currentSpeed === 'number') {
                            updateCurrentSpeedDisplay(response.currentSpeed);
                            updateBadge(response.currentSpeed);
                            document.getElementById('currentSpeed').value = Math.round(response.currentSpeed * 100);
                        }
                    }
                });
            } catch (msgErr) {
                // Игнорируем ошибки сообщений
            }
        }
    } catch (e) {
        // Игнорируем ожидаемые ошибки
        const errorMsg = e.message || e.toString() || '';
        if (errorMsg.includes('Extension context invalidated') ||
            errorMsg.includes('chrome://') ||
            errorMsg.includes('Cannot access')) {
            return;
        }
        // Логируем только неожиданные ошибки
        console.error('Ошибка обновления информации о видео:', e);
    }
}

// Обновление отображения текущей скорости
function updateCurrentSpeedDisplay(speed) {
    const speedDisplay = document.getElementById('currentSpeedDisplay');
    if (speedDisplay) {
        speedDisplay.textContent = speed.toFixed(2) + 'x';
    }
    
    // Обновляем активную ячейку
    document.querySelectorAll('.preset-cell').forEach((cell, index) => {
        const presetSpeed = currentPresets[index]?.speed;
        if (presetSpeed && Math.abs(presetSpeed - speed * 100) < 1) {
            cell.classList.add('active');
        } else {
            cell.classList.remove('active');
        }
    });
}

// Обновление badge на иконке расширения
async function updateBadge(speed, tabId = activeTabId) {
    try {
        if (chrome && chrome.action && chrome.action.setBadgeText) {
            const speedText = speed === 1.0 ? '' : speed.toFixed(2);
            if (typeof tabId !== 'number') {
                return;
            }
            await chrome.action.setBadgeText({ text: speedText, tabId });
            await chrome.action.setBadgeBackgroundColor({ color: '#2196F3', tabId });
        }
    } catch (e) {
        // Игнорируем ошибки badge
    }
}

// Форматирование времени
function formatTime(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Настройка обработчиков событий
function setupEventListeners() {
    // Toggle
    document.getElementById('toggleEnabled').addEventListener('change', (e) => {
        isEnabled = e.target.checked;
        saveSettings();
    });
    
    // Scope
    document.querySelectorAll('input[name="scope"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentScope = e.target.value;
            saveSettings();
        });
    });
    
    // Speed adjustments
    document.getElementById('decrease5').addEventListener('click', () => adjustSpeed(-5));
    document.getElementById('decrease1').addEventListener('click', () => adjustSpeed(-1));
    document.getElementById('increase1').addEventListener('click', () => adjustSpeed(1));
    document.getElementById('increase5').addEventListener('click', () => adjustSpeed(5));
    
    // Manual speed input
    document.getElementById('currentSpeed').addEventListener('change', (e) => {
        const speed = parseInt(e.target.value);
        if (speed >= 25 && speed <= 1600) {
            applySpeed(speed);
        }
    });
    
    // Reset all
    document.getElementById('resetAll').addEventListener('click', async () => {
        if (confirm('Сбросить все настройки?')) {
            currentPresets = createDefaultPresets();
            isEnabled = true;
            currentScope = 'tab';
            await saveSettings();
            await loadSettings();
            renderPresets();
        }
    });
    
    // Modal
    document.getElementById('closeModal').addEventListener('click', closeEditModal);
    document.getElementById('cancelEdit').addEventListener('click', closeEditModal);
    document.getElementById('saveEdit').addEventListener('click', saveEdit);
    document.getElementById('clearShortcut').addEventListener('click', () => {
        document.getElementById('editShortcut').value = '';
    });
    
    // Закрытие модального окна по клику вне его
    document.getElementById('editModal').addEventListener('click', (e) => {
        if (e.target.id === 'editModal') {
            closeEditModal();
        }
    });
}

// Корректировка скорости
function adjustSpeed(delta) {
    const current = parseInt(document.getElementById('currentSpeed').value);
    const newSpeed = Math.max(25, Math.min(1600, current + delta));
    applySpeed(newSpeed);
}

// Обработка сообщений от content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'speedChanged') {
        if (!sender || !sender.tab || !activeTabId || sender.tab.id !== activeTabId) {
            return;
        }
        const speedPercent = Math.round(request.speed * 100);
        document.getElementById('currentSpeed').value = speedPercent;
        updateCurrentSpeedDisplay(request.speed);
        updateBadge(request.speed);
    }
});

// Инициализация при загрузке
init();
