// Поиск всех видео элементов на странице
function findVideos() {
    return document.querySelectorAll('video');
}

let currentTargetSpeed = 1.0;
const observedVideos = new WeakSet();
let speedProtectionObserver = null;
let hasInitializedDefaultSpeed = false;
let lastResolvedScope = 'all';

function getStorageKeysForCurrentPage() {
    try {
        const url = new URL(window.location.href);
        return {
            tabKey: `speed_tab_${url.href}`,
            domainKey: `speed_domain_${url.hostname}`,
            allKey: 'speed_all'
        };
    } catch (error) {
        return {
            tabKey: null,
            domainKey: null,
            allKey: 'speed_all'
        };
    }
}

function getStorageKeyForScope(scope) {
    const { tabKey, domainKey } = getStorageKeysForCurrentPage();
    switch (scope) {
        case 'tab':
            return tabKey || 'speed_all';
        case 'domain':
            return domainKey || 'speed_all';
        case 'all':
            return 'speed_all';
        default:
            return tabKey || domainKey || 'speed_all';
    }
}

function loadSavedSpeedForCurrentPage(callback) {
    try {
        if (!chrome || !chrome.storage || !chrome.storage.local) {
            return;
        }

        const { tabKey, domainKey, allKey } = getStorageKeysForCurrentPage();
        const keys = [];
        if (tabKey) keys.push(tabKey);
        if (domainKey) keys.push(domainKey);
        keys.push(allKey);

        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime.lastError) {
                return;
            }

            let resolvedSpeed;
            let resolvedScope;

            if (typeof result[allKey] === 'number') {
                resolvedSpeed = result[allKey];
                resolvedScope = 'all';
            }

            if (domainKey && typeof result[domainKey] === 'number') {
                resolvedSpeed = result[domainKey];
                resolvedScope = 'domain';
            }

            if (tabKey && typeof result[tabKey] === 'number') {
                resolvedSpeed = result[tabKey];
                resolvedScope = 'tab';
            }

            // Default: 100% (1.0) on first run if nothing saved yet.
            if (typeof resolvedSpeed !== 'number') {
                resolvedSpeed = 1.0;
                resolvedScope = 'all';

                // Write default once (do not overwrite user's existing settings).
                if (!hasInitializedDefaultSpeed && typeof result[allKey] !== 'number') {
                    hasInitializedDefaultSpeed = true;
                    try {
                        chrome.storage.local.set({ [allKey]: 1.0 }, () => {});
                    } catch (e) {
                        // ignore
                    }
                }
            }

            callback(resolvedSpeed, resolvedScope);
        });
    } catch (error) {
        // Игнорируем ошибки storage
    }
}

function setPlaybackSpeed(speed, scope, options = {}) {
    const { persist = true } = options;
    try {
        // Apply to all current videos; future videos are handled by speed protection hooks.
        document.querySelectorAll('video').forEach((v) => {
            try {
                v.playbackRate = speed;
            } catch (e) {
                // ignore per-video failures
            }
        });
    } catch (e) {
        console.error('❌ Ошибка установки скорости:', e);
        return;
    }
    
    currentTargetSpeed = speed;
    if (persist) {
        try {
            if (chrome && chrome.storage && chrome.storage.local) {
                const storageKey = getStorageKeyForScope(scope);

                if (storageKey) {
                    chrome.storage.local.set({ [storageKey]: speed }, () => {
                        if (chrome.runtime.lastError) {
                            return;
                        }
                    });
                }
            }
        } catch (storeError) {
            // Игнорируем ошибки storage
        }
    }
    
    // Отправляем сообщение в background для обновления badge
    // Используем setTimeout чтобы избежать ошибок "Extension context invalidated"
    setTimeout(() => {
        try {
            if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    action: 'updateBadge',
                    speed: speed
                }).catch(() => {
                    // Игнорируем ошибки
                });
            }
        } catch (e) {
            // Игнорируем ошибки
        }
    }, 0);
}

function enforceTargetSpeed(video) {
    if (!video || typeof currentTargetSpeed !== 'number') {
        return;
    }

    if (Math.abs(video.playbackRate - currentTargetSpeed) > 0.001) {
        try {
            video.playbackRate = currentTargetSpeed;
        } catch (e) {
            // Игнорируем ошибки установки playbackRate
        }
    }
}

function bindSpeedProtection(video) {
    if (!video || observedVideos.has(video)) {
        return;
    }

    observedVideos.add(video);
    video.addEventListener('ratechange', () => enforceTargetSpeed(video), true);
    video.addEventListener('loadedmetadata', () => enforceTargetSpeed(video), true);
    video.addEventListener('play', () => enforceTargetSpeed(video), true);
}

function setupSpeedProtection() {
    document.querySelectorAll('video').forEach(bindSpeedProtection);

    if (speedProtectionObserver) {
        return;
    }

    speedProtectionObserver = new MutationObserver(() => {
        document.querySelectorAll('video').forEach(bindSpeedProtection);
    });

    const root = document.documentElement || document.body;
    if (root) {
        speedProtectionObserver.observe(root, { childList: true, subtree: true });
    }
}

// Получение информации о видео
function getVideoInfo() {
    const videos = findVideos();
    if (videos.length === 0) {
        return { hasVideo: false, playing: false, currentTime: 0, currentSpeed: 1.0 };
    }
    
    const video = videos[0]; // Берем первое видео
    return {
        hasVideo: true,
        playing: !video.paused,
        currentTime: video.currentTime,
        currentSpeed: video.playbackRate || 1.0
    };
}

function applyStoredSpeedFromStorage() {
    loadSavedSpeedForCurrentPage((savedSpeed, savedScope) => {
        // Always resolve to a number (defaults to 1.0).
        if (typeof savedSpeed === 'number') {
            lastResolvedScope = savedScope || 'all';
            // Set target immediately so newly-added videos inherit speed via protection.
            currentTargetSpeed = savedSpeed;
            setupSpeedProtection();
            waitForVideoToApply(savedSpeed, savedScope);
        }
    });
}

function waitForVideoToApply(speed, scope, attempts = 0) {
    const video = document.querySelector('video');
    if (video) {
        setPlaybackSpeed(speed, scope || 'all', { persist: false });
        return;
    }

    if (attempts >= 10) {
        return;
    }

    setTimeout(() => waitForVideoToApply(speed, scope, attempts + 1), 350);
}

// Обработка сообщений от popup
try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        try {
            if (request.action === 'setSpeed') {
                setPlaybackSpeed(request.speed, request.scope);
                const videoInfo = getVideoInfo();
                // Отправляем сообщение для обновления badge
                try {
                    chrome.runtime.sendMessage({
                        action: 'updateBadge',
                        speed: request.speed
                    }).catch(() => {});
                } catch (e) {
                    // Игнорируем ошибки
                }
                sendResponse({ success: true, currentSpeed: videoInfo.currentSpeed });
            } else if (request.action === 'getVideoInfo') {
                sendResponse(getVideoInfo());
            } else if (request.action === 'getCurrentSpeed') {
                const videos = findVideos();
                const currentSpeed = videos.length > 0 ? videos[0].playbackRate : 1.0;
                sendResponse({ currentSpeed: currentSpeed });
            } else if (request.action === 'getEffectiveSpeed') {
                loadSavedSpeedForCurrentPage((savedSpeed, savedScope) => {
                    const videos = findVideos();
                    const currentSpeed = videos.length > 0 ? videos[0].playbackRate : savedSpeed;
                    sendResponse({
                        currentSpeed: typeof currentSpeed === 'number' ? currentSpeed : 1.0,
                        effectiveScope: savedScope || lastResolvedScope || 'all'
                    });
                });
                return true;
            } else if (request.action === 'applySavedSpeed') {
                applyStoredSpeedFromStorage();
                sendResponse({ success: true });
            }
        } catch (error) {
            // Игнорируем ошибки "Extension context invalidated"
            if (error.message && error.message.includes('Extension context invalidated')) {
                return false;
            }
            console.error('Ошибка обработки сообщения:', error);
        }
        
        return true;
    });
} catch (error) {
    // Игнорируем ошибки при установке слушателя
    if (error.message && error.message.includes('Extension context invalidated')) {
        // Расширение было перезагружено, это нормально
    }
}

// Применяем сохранённую скорость при загрузке страницы
applyStoredSpeedFromStorage();
document.addEventListener('DOMContentLoaded', applyStoredSpeedFromStorage);

// На фокусировке/возврате во вкладку перепроверяем и применяем скорость:
// page -> domain -> global
window.addEventListener('focus', applyStoredSpeedFromStorage, true);
window.addEventListener('pageshow', applyStoredSpeedFromStorage, true);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) applyStoredSpeedFromStorage();
});

function watchSpaNavigation() {
    let lastUrl = location.href;

    const handleNavigation = () => {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            applyStoredSpeedFromStorage();
        }
    };

    const wrapHistoryMethod = (method) => {
        const original = history[method];
        history[method] = function (...args) {
            const returnValue = original.apply(this, args);
            handleNavigation();
            return returnValue;
        };
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');

    window.addEventListener('popstate', handleNavigation);
    window.addEventListener('yt-navigate-finish', handleNavigation);
}

watchSpaNavigation();
setupSpeedProtection();

// Обработка горячих клавиш
let shortcutHandler = null;
let presetsCache = null;
let enabledCache = true;

// Загружаем настройки при загрузке
function loadShortcutSettings() {
    try {
        if (!chrome || !chrome.storage || !chrome.storage.sync) {
            return;
        }
        
        // Используем callback вместо async/await
        chrome.storage.sync.get(['presets', 'enabled'], (result) => {
            // Проверяем lastError
            if (chrome.runtime.lastError) {
                const errorMsg = chrome.runtime.lastError.message || '';
                if (!errorMsg.includes('Extension context invalidated')) {
                    console.error('Ошибка загрузки настроек:', chrome.runtime.lastError);
                }
                return;
            }
            
            if (result) {
                presetsCache = result.presets || [];
                enabledCache = result.enabled !== false;
            }
        });
    } catch (error) {
        // Игнорируем ошибки "Extension context invalidated"
        const errorMsg = error.message || error.toString() || '';
        if (!errorMsg.includes('Extension context invalidated')) {
            console.error('Ошибка загрузки настроек:', error);
        }
    }
}

// Слушаем изменения в storage
try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            try {
                if (areaName === 'sync') {
                    if (changes.presets) {
                        presetsCache = changes.presets.newValue || [];
                    }
                    if (changes.enabled) {
                        enabledCache = changes.enabled.newValue !== false;
                    }
                }
            } catch (error) {
                // Игнорируем ошибки
            }
        });
    }
} catch (error) {
    // Игнорируем ошибки при установке слушателя
}

function setupShortcutHandler() {
    if (shortcutHandler) {
        document.removeEventListener('keydown', shortcutHandler, true);
    }
    
    shortcutHandler = (e) => {
        // Проверяем, что не в поле ввода
        const target = e.target;
        if (target.tagName === 'INPUT' || 
            target.tagName === 'TEXTAREA' || 
            target.isContentEditable ||
            target.closest('input') ||
            target.closest('textarea')) {
            return;
        }
        
        const keys = [];
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');
        if (e.metaKey) keys.push('Meta');
        
        if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
            let key = e.key;
            // Обработка специальных клавиш
            if (key === ' ') key = 'Space';
            else if (key.length === 1) key = key.toUpperCase();
            keys.push(key);
        }
        
        if (keys.length === 0) return;
        
        const shortcut = keys.join('+');
        
        // Используем кэш для быстрой проверки
        if (!enabledCache) return;
        
        const preset = presetsCache.find(p => p.shortcut && p.shortcut === shortcut);
        
        if (preset) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            setPlaybackSpeed(preset.speed / 100, 'tab');
            
            // Уведомляем popup об изменении (если открыт)
            try {
                if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
                    chrome.runtime.sendMessage({
                        action: 'speedChanged',
                        speed: preset.speed / 100
                    }).catch(() => {});
                }
            } catch (err) {
                // Игнорируем ошибки
            }
            
            return false;
        }
    };
    
    document.addEventListener('keydown', shortcutHandler, true);
}

// Загружаем настройки и настраиваем обработчик
try {
    loadShortcutSettings();
    
    // Настраиваем обработчик горячих клавиш
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupShortcutHandler);
    } else {
        setupShortcutHandler();
    }
} catch (error) {
    // Игнорируем ошибки при инициализации
    const errorMsg = error.message || error.toString() || '';
    if (!errorMsg.includes('Extension context invalidated')) {
        console.error('Ошибка инициализации:', error);
    }
}

