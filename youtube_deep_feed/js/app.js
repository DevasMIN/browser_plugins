// Deep Feed: логика синхронизации и интерфейс ленты.

import {
  browse, sendFeedback, addToWatchLater, removeFromWatchLater, fetchWatchLaterIds,
  collectKey, sleep, findToken, normThumbUrl,
  parseChannels, parseLockups, parseHistory, parseRelativeDate, canonicalPubTs,
} from './innertube.js';
import * as db from './db.js';

/** Просмотренным считаем видео с прогрессом от этого процента. */
const WATCHED_PCT = 90;
/** Сколько непросмотренных видео держать в запасе у каждого канала. */
const TARGET_UNWATCHED = 20;
/** Максимум страниц подкачки вглубь на канал за одну синхронизацию. */
const MAX_DEEPEN_PAGES = 8;
/** Пауза между запросами к YouTube, чтобы не злить антиспам. */
const REQUEST_DELAY = 350;
/** Сколько карточек добавляется за одну порцию скролла. */
const PAGE_SIZE = 60;
/** Импорт истории останавливается после стольких подряд уже известных отметок. */
const HISTORY_KNOWN_STOP = 300;
/**
 * Максимум страниц истории за один заход (~100 отметок/стр). На первом запуске
 * условие «уже известных» не срабатывает, иначе история листалась бы за все годы.
 * Возобновляемо: кнопка «История» продолжит с сохранённого места.
 */
const HISTORY_MAX_PAGES = 40;

const state = {
  channels: new Map(),   // id -> запись канала
  watched: new Map(),    // videoId -> pct
  hidden: new Set(),     // videoId (скрытые: вручную, из ленты, WL и т.п.)
  hiddenSync: new Set(), // подмножество hidden, которое синхронизируем между устройствами
  wl: new Set(),         // videoId в плейлисте «Смотреть позже»
  filters: { hideWatched: true, search: '', channel: '' },
  cursor: null,
  feedDone: false,
  loadingPage: false,
  syncing: false,
  abort: false,
  pendingNew: 0,
};

/**
 * Источники скрытия, которые синхронизируются между устройствами через
 * chrome.storage.sync. feed-diff НЕ синхронизируем — он заново вычисляется
 * из нативной ленты на каждом устройстве и раздул бы квоту sync.
 */
const SYNCABLE_HIDE_SRC = new Set(['manual', 'yt-feedback', 'wl']);
/** Префикс и размер чанков зеркала скрытого в chrome.storage.sync. */
const SYNC_KEY_PREFIX = 'dfh_';
const SYNC_CHUNK_CHARS = 7000;

/** Лёгкая автопроверка новых видео (нативная лента), пока страница открыта. */
const AUTO_FEED_INTERVAL = 15 * 60e3;
/** Полный обход каналов — не чаще, чем раз в столько. */
const FULL_SYNC_INTERVAL = 6 * 3600e3;

const $ = (id) => document.getElementById(id);

// ---------- Прогресс/статус ----------

function status(text, pct = null) {
  $('status').hidden = !text;
  $('statusText').textContent = text || '';
  $('statusBar').hidden = pct == null;
  if (pct != null) $('statusBar').value = pct;
}

function setSyncing(on) {
  state.syncing = on;
  state.abort = false;
  for (const id of ['btnSync', 'btnHistory', 'btnStart']) {
    const b = $(id);
    if (b) b.disabled = on;
  }
  $('btnAbort').hidden = !on;
  if (!on) status('');
}

function checkAbort() {
  if (state.abort) throw new Error('aborted');
}

// ---------- Скрытое: хранение + синхронизация между устройствами ----------

let syncPushTimer = null;

/** Добавляет видео в скрытые (локально + IndexedDB + при необходимости в sync). */
async function addHidden(id, src) {
  const first = !state.hidden.has(id);
  state.hidden.add(id);
  await db.put('hidden', { id, at: Date.now(), src });
  if (SYNCABLE_HIDE_SRC.has(src) && !state.hiddenSync.has(id)) {
    state.hiddenSync.add(id);
    scheduleHiddenPush();
  }
  return first;
}

/** Убирает видео из скрытых (для отмены). */
async function removeHidden(id) {
  state.hidden.delete(id);
  await db.del('hidden', id);
  if (state.hiddenSync.delete(id)) scheduleHiddenPush();
}

function scheduleHiddenPush() {
  if (!(chrome.storage && chrome.storage.sync)) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(pushHiddenSync, 1500);
}

/**
 * Выкладывает syncable-скрытое в chrome.storage.sync (общий для всех устройств,
 * где включена синхронизация Chrome). Пишем чанками: у sync жёсткие лимиты
 * (100 КБ всего, 8 КБ на элемент). Перед записью подтягиваем чужие правки,
 * чтобы одновременная запись с двух устройств не затирала друг друга.
 */
async function pushHiddenSync() {
  if (!(chrome.storage && chrome.storage.sync)) return;
  await pullHiddenSync();
  const ids = [...state.hiddenSync];
  const chunks = [];
  let cur = '';
  for (const id of ids) {
    if (cur.length + id.length + 1 > SYNC_CHUNK_CHARS) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? ',' : '') + id;
  }
  if (cur) chunks.push(cur);

  const toSet = {};
  chunks.forEach((c, i) => { toSet[SYNC_KEY_PREFIX + i] = c; });
  try {
    const all = await chrome.storage.sync.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith(SYNC_KEY_PREFIX) && !(k in toSet));
    if (stale.length) await chrome.storage.sync.remove(stale);
    await chrome.storage.sync.set(toSet);
  } catch (e) {
    console.warn('sync push fail', e);
    status(`Синхронизация скрытого: не поместилось (${e.message})`);
  }
}

/** Подтягивает скрытое с других устройств (только добавление). Возвращает новые id. */
async function pullHiddenSync() {
  const added = [];
  if (!(chrome.storage && chrome.storage.sync)) return added;
  let all;
  try {
    all = await chrome.storage.sync.get(null);
  } catch (e) {
    return added;
  }
  for (const k of Object.keys(all)) {
    if (!k.startsWith(SYNC_KEY_PREFIX) || typeof all[k] !== 'string') continue;
    for (const id of all[k].split(',')) {
      if (!id) continue;
      state.hiddenSync.add(id);
      if (!state.hidden.has(id)) {
        state.hidden.add(id);
        await db.put('hidden', { id, at: Date.now(), src: 'sync' });
        added.push(id);
      }
    }
  }
  return added;
}

// ---------- «Смотреть позже» ----------

/** Обновляет локальный список WL с YouTube (сервер общий для всех устройств). */
async function refreshWatchLater() {
  try {
    const ids = await fetchWatchLaterIds();
    state.wl = ids;
    await db.metaSet('wl', [...ids]);
  } catch (e) {
    console.warn('WL fetch fail', e);
  }
}

// ---------- Синхронизация ----------

/** Список подписок: FEchannels + продолжения. */
async function syncChannels() {
  status('Читаю список подписок…');
  let json = await browse({ browseId: 'FEchannels' });
  const found = [];
  for (let page = 0; page < 30; page++) {
    checkAbort();
    found.push(...parseChannels(json));
    const token = findToken(json);
    if (!token) break;
    await sleep(REQUEST_DELAY);
    json = await browse({ continuation: token });
  }
  let added = 0;
  for (const ch of found) {
    const old = state.channels.get(ch.id);
    const row = old
      ? { ...old, title: ch.title, thumb: ch.thumb }
      : {
          ...ch, enabled: 1, hiddenChannel: 0, backfillDone: 0,
          nextToken: null, plKind: null, lastSync: 0, videoCount: 0,
        };
    if (!old) added++;
    state.channels.set(ch.id, row);
  }
  await db.bulkPut('channels', [...state.channels.values()]);
  status(`Подписок: ${found.length} (новых: ${added})`);
  return found.length;
}

/**
 * Одна страница плейлиста загрузок канала.
 * Пробуем UULF (без Shorts), при пустоте падаем на UU (все загрузки).
 */
async function fetchUploadsPage(ch, token = null) {
  if (token) {
    const json = await browse({ continuation: token });
    return { json, plKind: ch.plKind };
  }
  const kinds = ch.plKind ? [ch.plKind] : ['UULF', 'UU'];
  for (const kind of kinds) {
    const json = await browse({ browseId: 'VL' + kind + ch.id.slice(2) });
    if (parseLockups(json).length || kinds.length === 1) return { json, plKind: kind };
    await sleep(REQUEST_DELAY);
  }
  return { json: null, plKind: null };
}

/** Обновляет отметку просмотра, если новый процент больше сохранённого. */
async function noteWatched(id, percent, src) {
  if (percent == null) return;
  const old = state.watched.get(id) ?? -1;
  if (percent > old) {
    state.watched.set(id, percent);
    await db.put('watched', { id, pct: percent, src, at: Date.now() });
  }
}

/** Сохраняет порцию видео канала; возвращает сколько было новых. */
async function storeVideos(ch, lockups) {
  const now = Date.now();
  const rows = [];
  let prevTs = null;
  let added = 0;
  for (const v of lockups) {
    const existing = await db.get('videos', v.id);
    const canon = canonicalPubTs(v.pubText, now);
    let ts = existing?.ts ?? (canon ? canon.ts : null);
    // Дата не распарсилась — держим порядок плейлиста, вставая чуть раньше соседа
    if (ts == null) ts = prevTs != null ? prevTs - 1000 : now;
    // Плейлист идёт от новых к старым: внутри одной «корзины» дат сохраняем
    // порядок цепочкой −1с (иначе одинаковые канонические метки перемешаются)
    if (!existing && prevTs != null && ts >= prevTs) ts = prevTs - 1000;
    prevTs = ts;
    if (!existing) added++;
    rows.push({
      id: v.id, ch: ch.id, title: v.title, dur: v.dur, views: v.views,
      pubText: v.pubText, ts, addedAt: existing?.addedAt ?? now,
      // Тип (эфир/запланировано) берём из свежего парсинга: эфир заканчивается,
      // премьера выходит — статус должен обновляться при каждой синхронизации
      kind: v.kind ?? null, schedText: v.schedText ?? null,
      // Токен «Скрыть» приходит только из нативной ленты — не затираем его
      fbToken: existing?.fbToken ?? null,
    });
    await noteWatched(v.id, v.percent, 'playlist');
  }
  await db.bulkPut('videos', rows);
  return added;
}

/**
 * Синхронизация с нативной лентой подписок YouTube (FEsubscriptions).
 * Даёт два бонуса, которых нет у плейлистов:
 * 1) свежие отметки прогресса просмотра;
 * 2) вычисление скрытых: видео, которое по дате попадает в окно ленты,
 *    но в ленте отсутствует, — скрыто кнопкой «Скрыть» на YouTube.
 *    (Сама метка «скрыто» через API не читается — она есть только косвенно.)
 * Дифф включается, только если лента выглядит здоровой (после массовых
 * изменений подписок YouTube пересобирает её и какое-то время отдаёт пустоту).
 */
async function syncFeed() {
  status('Читаю ленту подписок YouTube…');
  await refreshWatchLater();
  const now = Date.now();
  const feedIds = new Set();
  let minTs = Infinity;
  let newCount = 0;
  let json;
  try {
    json = await browse({ browseId: 'FEsubscriptions' });
  } catch (e) {
    return 0; // лента недоступна — не страшно, основной источник — плейлисты
  }
  let prevFeedTs = null;
  for (let page = 0; page < 60; page++) {
    checkAbort();
    const rows = [];
    for (const v of parseLockups(json)) {
      feedIds.add(v.id);
      const ts0 = parseRelativeDate(v.pubText, now);
      if (ts0 != null && ts0 < minTs) minTs = ts0;
      if (v.chId && state.channels.has(v.chId)) {
        const existing = await db.get('videos', v.id);
        if (!existing) newCount++;
        // Каноничная метка + цепочка −1с: лента идёт от новых к старым,
        // сохраняем её порядок внутри одинаковых «корзин» дат
        const canon = canonicalPubTs(v.pubText, now);
        let ts = existing?.ts ?? (canon ? canon.ts : now);
        if (!existing && prevFeedTs != null && ts >= prevFeedTs) ts = prevFeedTs - 1000;
        prevFeedTs = ts;
        rows.push({
          id: v.id, ch: v.chId, title: v.title, dur: v.dur, views: v.views,
          pubText: v.pubText, ts, addedAt: existing?.addedAt ?? now,
          kind: v.kind ?? null, schedText: v.schedText ?? null,
          fbToken: v.fbToken || existing?.fbToken || null,
        });
      }
      await noteWatched(v.id, v.percent, 'feed');
    }
    await db.bulkPut('videos', rows);
    status(`Лента YouTube: получено ${feedIds.size} видео…`);
    const token = findToken(json);
    if (!token) break;
    await sleep(REQUEST_DELAY);
    json = await browse({ continuation: token });
  }

  // Дифф скрытых: только по здоровой ленте и только внутри её окна,
  // с отступами от краёв (свежак ещё не везде разложен, край окна неточен)
  const windowDays = (now - minTs) / 86400e3;
  if (feedIds.size < 100 || windowDays < 7) {
    status(`Лента YouTube: ${feedIds.size} видео — мало для диффа скрытых, пропускаю`);
    return newCount;
  }
  const oldEdge = minTs + 86400e3;
  const newEdge = now - 2 * 86400e3;
  const rows = [];
  for (const v of await db.getAll('videos')) {
    if (v.ts <= oldEdge || v.ts >= newEdge) continue;
    if (feedIds.has(v.id) || state.hidden.has(v.id)) continue;
    const ch = state.channels.get(v.ch);
    if (!ch || ch.hiddenChannel || !ch.enabled) continue;
    state.hidden.add(v.id);
    rows.push({ id: v.id, at: now, src: 'feed-diff' });
  }
  await db.bulkPut('hidden', rows);
  status(`Лента YouTube: ${feedIds.size} видео, распознано скрытых: ${rows.length}`);
  return newCount;
}

/** Сколько непросмотренных и нескрытых видео канала уже лежит в базе. */
async function unwatchedCount(chId) {
  const vids = await db.getAllByIndex('videos', 'ch', chId);
  let n = 0;
  for (const v of vids) {
    if (!state.hidden.has(v.id) && !isWatchedVideo(v)) n++;
  }
  return n;
}

/**
 * Синхронизация канала: первая страница (~100 видео) + подкачка вглубь,
 * пока в запасе не наберётся TARGET_UNWATCHED непросмотренных.
 * Прогресс вглубь хранится в ch.nextToken и переживает перезапуски.
 */
async function syncChannel(ch) {
  const { json, plKind } = await fetchUploadsPage(ch);
  if (!json) {
    ch.backfillDone = 1; // канал без загрузок (топик-каналы и т.п.)
    return 0;
  }
  ch.plKind = plKind;
  let added = await storeVideos(ch, parseLockups(json));
  const page1Token = findToken(json);
  if (!ch.nextToken && !ch.backfillDone) ch.nextToken = page1Token;
  if (!ch.nextToken) ch.backfillDone = 1;

  let pages = 0;
  let triedFresh = false;
  while (
    !ch.backfillDone &&
    !ch.onlyNew &&
    pages < MAX_DEEPEN_PAGES &&
    (await unwatchedCount(ch.id)) < TARGET_UNWATCHED
  ) {
    checkAbort();
    await sleep(REQUEST_DELAY);
    try {
      const cont = await browse({ continuation: ch.nextToken });
      added += await storeVideos(ch, parseLockups(cont));
      ch.nextToken = findToken(cont);
      if (!ch.nextToken) ch.backfillDone = 1;
      pages++;
    } catch (e) {
      if (e.message === 'aborted') throw e;
      // Сохранённый токен мог протухнуть — один раз начинаем заново с 1-й страницы
      if (!triedFresh && page1Token) {
        triedFresh = true;
        ch.nextToken = page1Token;
      } else {
        break;
      }
    }
  }
  return added;
}

/** Синхронизация всех каналов: новые видео + поддержание запаса вглубь. */
async function quickSync() {
  let totalNew = await syncFeed();
  const list = [...state.channels.values()].filter((c) => c.enabled && !c.hiddenChannel);
  let done = 0;
  for (const ch of list) {
    checkAbort();
    status(`Синхронизация: ${ch.title} (${done + 1}/${list.length})`, (done / list.length) * 100);
    try {
      totalNew += await syncChannel(ch);
      ch.lastSync = Date.now();
      await db.put('channels', ch);
    } catch (e) {
      if (e.message === 'aborted') throw e;
      console.warn('sync fail', ch.title, e);
    }
    done++;
    await sleep(REQUEST_DELAY);
  }
  await db.metaSet('lastQuickSync', Date.now());
  status(`Готово: +${totalNew} новых видео`);
  return totalNew;
}

/** Импорт отметок «просмотрено» из истории YouTube. Возобновляемый. */
async function importHistory() {
  let token = await db.metaGet('historyToken');
  let json = token ? await browse({ continuation: token }) : await browse({ browseId: 'FEhistory' });
  let imported = 0;
  let consecutiveKnown = 0;
  const now = Date.now();
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    checkAbort();
    for (const h of parseHistory(json)) {
      const old = state.watched.get(h.id);
      if (old != null && old >= h.percent) {
        consecutiveKnown++;
      } else {
        consecutiveKnown = 0;
        state.watched.set(h.id, h.percent);
        await db.put('watched', { id: h.id, pct: h.percent, src: 'history', at: now });
        imported++;
      }
    }
    status(`История: импортировано ${imported} отметок (стр. ${page + 1})`);
    token = findToken(json);
    if (!token || consecutiveKnown >= HISTORY_KNOWN_STOP) {
      token = null;
      break;
    }
    await db.metaSet('historyToken', token);
    await sleep(REQUEST_DELAY);
    json = await browse({ continuation: token });
  }
  await db.metaSet('historyToken', token);
  status(`История: +${imported} отметок${token ? ' (нажмите «История» ещё раз, чтобы продолжить глубже)' : ' — вся история пройдена'}`);
}

/**
 * Обёртка запуска задач синхронизации.
 * auto=true — фоновый запуск: ленту не перерисовываем из-под прокрутки,
 * а при новых видео показываем кнопку «↑ N новых» (или обновляем сразу,
 * если пользователь и так вверху страницы).
 */
async function runTask(fn, auto = false) {
  if (state.syncing) return;
  setSyncing(true);
  try {
    const added = await fn();
    await refreshStats();
    if (!auto) {
      resetFeed();
    } else if (added > 0) {
      if (window.scrollY < 200) {
        resetFeed();
      } else {
        state.pendingNew += added;
        const b = $('btnFresh');
        b.textContent = `↑ ${state.pendingNew} новых`;
        b.hidden = false;
      }
    }
  } catch (e) {
    if (e.message !== 'aborted') {
      console.error(e);
      status(`Ошибка: ${e.message}. Проверьте, что вы залогинены на youtube.com в этом браузере.`);
    }
  } finally {
    state.syncing = false;
    $('btnAbort').hidden = true;
    for (const id of ['btnSync', 'btnHistory', 'btnStart']) {
      const b = $(id);
      if (b) b.disabled = false;
    }
  }
}

// ---------- Лента ----------

/**
 * Процент просмотра с учётом «водяного знака» канала: если каналу нажали
 * «только новые», ВСЁ старше момента нажатия считается просмотренным —
 * даже видео, которых ещё не было в базе. Явная отметка (в т.ч. «не смотрел»,
 * pct=0) сильнее водяного знака.
 */
function watchedPctOf(v) {
  const explicit = state.watched.get(v.id);
  if (explicit != null) return explicit;
  const ch = state.channels.get(v.ch);
  if (ch && ch.watchedBefore && v.ts < ch.watchedBefore) return 100;
  return 0;
}

function isWatchedVideo(v) {
  return watchedPctOf(v) >= WATCHED_PCT;
}

function acceptVideo(v) {
  if (state.hidden.has(v.id)) return false;
  if (state.wl.has(v.id)) return false; // уже в «Смотреть позже»
  const ch = state.channels.get(v.ch);
  if (!ch || ch.hiddenChannel) return false;
  if (state.filters.channel && v.ch !== state.filters.channel) return false;
  if (state.filters.hideWatched && isWatchedVideo(v)) return false;
  if (state.filters.search) {
    const s = state.filters.search;
    const chTitle = ch.title.toLowerCase();
    if (!v.title.toLowerCase().includes(s) && !chTitle.includes(s)) return false;
  }
  return true;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function makeCard(v) {
  const ch = state.channels.get(v.ch);
  const pct = state.watched.get(v.id) ?? 0;

  const card = document.createElement('div');
  card.className = 'card' + (isWatchedVideo(v) ? ' watched' : '');
  card.dataset.id = v.id;

  const thumb = document.createElement('a');
  thumb.className = 'thumb';
  thumb.href = `https://www.youtube.com/watch?v=${v.id}`;
  thumb.target = '_blank';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
  thumb.appendChild(img);
  if (v.dur) {
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = v.dur;
    thumb.appendChild(dur);
  }
  if (v.kind) {
    const kb = document.createElement('span');
    kb.className = 'kbadge ' + v.kind;
    kb.textContent =
      v.kind === 'live' ? 'В ЭФИРЕ' : v.kind === 'upcoming' ? 'ЗАПЛАНИРОВАНО' : 'СТРИМ';
    thumb.appendChild(kb);
  }
  if (pct > 0) {
    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('div');
    fill.style.width = `${Math.min(pct, 100)}%`;
    bar.appendChild(fill);
    thumb.appendChild(bar);
  }
  card.appendChild(thumb);

  const title = document.createElement('a');
  title.className = 'title';
  title.href = thumb.href;
  title.target = '_blank';
  title.textContent = v.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dateText = v.kind === 'upcoming' && v.schedText ? v.schedText : v.pubText || fmtDate(v.ts);
  meta.textContent = `${ch ? ch.title : '?'} • ${dateText}${v.views ? ' • ' + v.views : ''}`;
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const btnL = document.createElement('button');
  btnL.textContent = '⏳ позже';
  btnL.title = 'Добавить в «Смотреть позже» на YouTube и убрать из ленты';
  btnL.onclick = () => watchLater(v, card, btnL);
  const btnW = document.createElement('button');
  btnW.textContent = isWatchedVideo(v) ? '↩ не смотрел' : '✓ просмотрено';
  btnW.onclick = () => toggleWatched(v, card, btnW);
  const btnH = document.createElement('button');
  btnH.textContent = '✕ скрыть';
  btnH.title = v.fbToken
    ? 'Скрыть из этой ленты и из ленты YouTube'
    : 'Скрыть это видео из ленты';
  btnH.onclick = () => hideVideo(v, card);
  actions.append(btnL, btnW, btnH);
  card.appendChild(actions);

  // Клик по видео = пометить просмотренным (настраивается здравым смыслом:
  // вы открыли его смотреть; вернуть можно кнопкой на карточке)
  const markOnOpen = () => {
    if (!isWatchedVideo(v)) markWatched(v.id, 100, 'manual').then(() => {
      card.classList.add('watched');
      btnW.textContent = '↩ не смотрел';
    });
  };
  thumb.addEventListener('click', markOnOpen);
  title.addEventListener('click', markOnOpen);

  return card;
}

async function markWatched(id, pct, src) {
  state.watched.set(id, pct);
  await db.put('watched', { id, pct, src, at: Date.now() });
}

async function toggleWatched(v, card, btn) {
  if (isWatchedVideo(v)) {
    // Явный pct=0 перебивает и старую отметку, и водяной знак «только новые»
    state.watched.set(v.id, 0);
    await db.put('watched', { id: v.id, pct: 0, src: 'manual', at: Date.now() });
    card.classList.remove('watched');
    btn.textContent = '✓ просмотрено';
  } else {
    await markWatched(v.id, 100, 'manual');
    card.classList.add('watched');
    btn.textContent = '↩ не смотрел';
    if (state.filters.hideWatched) card.remove();
  }
  refreshStats();
}

let toastTimer = null;

/** Тост с кнопкой «Отменить». onUndo вызывается при отмене. */
function showToast(text, onUndo) {
  const t = $('toast');
  $('toastText').textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  $('toastUndo').onclick = async () => {
    clearTimeout(toastTimer);
    t.hidden = true;
    try {
      await onUndo();
    } catch (e) {
      console.warn('undo fail', e);
    }
  };
  toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
}

/** Возвращает карточку на её место в ленте (для отмены скрытия). */
function restoreCard(card, parent, nextCard) {
  if (!parent || !parent.isConnected) {
    resetFeed();
    return;
  }
  parent.insertBefore(card, nextCard && nextCard.isConnected ? nextCard : null);
}

/** Токен отмены из ответа /feedback (обычно это второй feedbackToken). */
function undoTokenFromFeedback(resp, usedToken) {
  const toks = collectKey(resp || {}, 'feedbackToken')
    .filter((t) => typeof t === 'string' && t !== usedToken);
  return toks[0] || null;
}

async function hideVideo(v, card) {
  const parent = card.parentNode;
  const nextCard = card.nextSibling;
  await addHidden(v.id, 'manual');
  card.remove();

  // Если видео пришло из нативной ленты — скрываем и на YouTube
  let undoToken = null;
  if (v.fbToken) {
    try {
      undoToken = undoTokenFromFeedback(await sendFeedback(v.fbToken), v.fbToken);
    } catch (e) {
      console.warn('feedback fail', e);
    }
  }

  showToast(v.fbToken ? 'Скрыто (и на YouTube)' : 'Скрыто', async () => {
    await removeHidden(v.id);
    if (undoToken) {
      try { await sendFeedback(undoToken); } catch (e) { /* уже локально вернули */ }
    }
    restoreCard(card, parent, nextCard);
  });
}

async function watchLater(v, card, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  const parent = card.parentNode;
  const nextCard = card.nextSibling;
  try {
    await addToWatchLater(v.id);
    state.wl.add(v.id);
    await addHidden(v.id, 'wl');
    card.remove();
    showToast('В «Смотреть позже»', async () => {
      try { await removeFromWatchLater(v.id); } catch (e) { /* останется в WL */ }
      state.wl.delete(v.id);
      await removeHidden(v.id);
      restoreCard(card, parent, nextCard);
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '⏳ позже';
    status('Не удалось добавить в «Смотреть позже»: ' + e.message);
  }
}

// Поколение ленты: resetFeed его повышает, и результат страницы, начатой до
// сброса, выбрасывается. Раньше такой «поздний» результат молча блокировал
// перерисовку (флаг loadingPage), и новые видео появлялись только после F5.
let feedGen = 0;

async function loadMore() {
  if (state.loadingPage || state.feedDone) return;
  state.loadingPage = true;
  const gen = feedGen;
  const { items, cursor, done } = await db.pageVideos({
    cursor: state.cursor,
    limit: PAGE_SIZE,
    accept: acceptVideo,
  });
  state.loadingPage = false;
  if (gen !== feedGen) {
    loadMore(); // страница устарела (ленту сбросили) — перечитываем свежую
    return;
  }
  state.cursor = cursor;
  state.feedDone = done;
  const frag = document.createDocumentFragment();
  for (const v of items) frag.appendChild(makeCard(v));
  $('feed').appendChild(frag);
  $('feedEnd').hidden = !done;
}

function resetFeed() {
  feedGen++;
  state.cursor = null;
  state.feedDone = false;
  $('feed').textContent = '';
  $('feedEnd').hidden = true;
  loadMore();
}

async function refreshStats() {
  // Честный подсчёт по записям базы: сколько видео реально осталось к просмотру
  // (не скрыто, канал виден, не просмотрено явно или водяным знаком)
  const all = await db.getAll('videos');
  let unwatched = 0;
  for (const v of all) {
    if (state.hidden.has(v.id)) continue;
    const ch = state.channels.get(v.ch);
    if (!ch || ch.hiddenChannel) continue;
    if (!isWatchedVideo(v)) unwatched++;
  }
  $('stats').textContent = `${all.length} видео в базе · ${unwatched} к просмотру`;
}

// ---------- Панель каналов ----------

/**
 * «Только новые»: все текущие видео канала помечаются просмотренными,
 * докачка старых страниц выключается — в ленте остаются только свежие видео.
 */
async function markChannelOnlyNew(ch) {
  const now = Date.now();
  // Явные отметки для уже скачанных видео (для статистики и полосок)
  const rows = [];
  for (const v of await db.getAllByIndex('videos', 'ch', ch.id)) {
    if ((state.watched.get(v.id) ?? -1) < 100) {
      state.watched.set(v.id, 100);
      rows.push({ id: v.id, pct: 100, src: 'bulk', at: now });
    }
  }
  await db.bulkPut('watched', rows);
  // Водяной знак: ЛЮБОЕ видео канала старше этого момента считается
  // просмотренным, даже если его ещё нет в базе
  ch.onlyNew = 1;
  ch.watchedBefore = now;
  await db.put('channels', ch);
  return rows.length;
}

async function renderChannelPanel() {
  const filter = ($('channelSearch').value || '').trim().toLowerCase();
  const list = [...state.channels.values()]
    .filter((c) => !filter || c.title.toLowerCase().includes(filter))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  const box = $('channelList');
  box.textContent = '';
  for (const ch of list) {
    const row = document.createElement('div');
    row.className = 'chRow' + (ch.hiddenChannel ? ' chHidden' : '');
    const avatar = document.createElement('div');
    avatar.className = 'chAvatar';
    avatar.textContent = (ch.title || '?').trim().charAt(0).toUpperCase();
    const url = normThumbUrl(ch.thumb);
    if (url) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = url;
      img.onload = () => { avatar.textContent = ''; };
      img.onerror = () => { img.remove(); }; // остаётся буква-заглушка
      avatar.appendChild(img);
    }
    row.appendChild(avatar);
    const name = document.createElement('span');
    name.className = 'chName';
    name.textContent = ch.title;
    if (ch.onlyNew) name.title = 'Показываются только новые видео';
    row.appendChild(name);
    const cnt = document.createElement('span');
    cnt.className = 'chCount';
    db.count('videos', 'ch', ch.id).then((n) => {
      cnt.textContent = `${n}${ch.backfillDone ? '' : '…'}`;
    });
    row.appendChild(cnt);

    // «Только новые»: всё текущее — просмотрено, старое не докачиваем
    const btnNew = document.createElement('button');
    if (!ch.onlyNew) {
      btnNew.textContent = '✓ только новые';
      btnNew.title = 'Отметить все текущие видео канала просмотренными и показывать только новые';
      btnNew.onclick = async () => {
        const n = await markChannelOnlyNew(ch);
        status(`«${ch.title}»: помечено просмотренным ${n} видео, дальше только новые`);
        renderChannelPanel();
        await refreshStats();
        resetFeed();
      };
    } else {
      btnNew.textContent = '⟲ и старые';
      btnNew.title = 'Снова докачивать и показывать старые видео канала';
      btnNew.onclick = async () => {
        ch.onlyNew = 0;
        ch.watchedBefore = null;
        await db.put('channels', ch);
        renderChannelPanel();
        resetFeed();
      };
    }
    row.appendChild(btnNew);

    const btn = document.createElement('button');
    btn.textContent = ch.hiddenChannel ? 'показать' : 'скрыть';
    btn.onclick = async () => {
      ch.hiddenChannel = ch.hiddenChannel ? 0 : 1;
      await db.put('channels', ch);
      renderChannelPanel();
      resetFeed();
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}

// ---------- Резервная копия / перенос ----------

const BACKUP_STORES = ['channels', 'videos', 'watched', 'hidden', 'meta'];

/** Выгружает всю базу и настройки в JSON-файл. */
async function exportBackup() {
  status('Готовлю резервную копию…');
  const data = {};
  for (const s of BACKUP_STORES) data[s] = await db.getAll(s);
  const blob = new Blob([JSON.stringify({ format: 'deepfeed', v: 1, at: Date.now(), data })], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deepfeed-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  const total = data.videos.length;
  status(`Экспортировано: ${total} видео, ${data.channels.length} каналов`);
}

/** Загружает базу из JSON-файла (слияние: существующие записи перезаписываются). */
async function importBackup(file) {
  status('Читаю файл…');
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    status('Не удалось прочитать файл: не JSON');
    return;
  }
  const data = parsed.data || parsed;

  // Останавливаем идущую синхронизацию: она держит каналы в памяти и после
  // импорта записала бы их поверх импортированных — терялись бы, например,
  // водяные знаки «только новые»
  if (state.syncing) {
    state.abort = true;
    status('Останавливаю синхронизацию перед импортом…');
    for (let i = 0; i < 150 && state.syncing; i++) await sleep(200);
  }
  let counts = [];
  for (const s of BACKUP_STORES) {
    if (Array.isArray(data[s])) {
      await db.bulkPut(s, data[s]);
      counts.push(`${s}: ${data[s].length}`);
    }
  }
  status(`Импорт завершён (${counts.join(', ')}). Перезагружаю…`);
  setTimeout(() => location.reload(), 800);
}

// ---------- Инициализация ----------

function fillChannelFilter() {
  const sel = $('channelFilter');
  while (sel.options.length > 1) sel.remove(1);
  const list = [...state.channels.values()]
    .filter((c) => !c.hiddenChannel)
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  for (const ch of list) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.title;
    sel.appendChild(opt);
  }
}

async function init() {
  await db.openDb();
  for (const ch of await db.getAll('channels')) state.channels.set(ch.id, ch);
  for (const w of await db.getAll('watched')) state.watched.set(w.id, w.pct);
  for (const h of await db.getAll('hidden')) {
    state.hidden.add(h.id);
    if (SYNCABLE_HIDE_SRC.has(h.src) || h.src === 'sync') state.hiddenSync.add(h.id);
  }
  state.wl = new Set(await db.metaGet('wl', []));

  // Одноразовая миграция меток времени (v0.9.10): раньше метка считалась от
  // момента синхронизации конкретного канала, и внутри одной «корзины» дат
  // («8 месяцев назад») лента группировалась блоками по каналам. Пересчитываем
  // в канонические метки; внутри корзины расталкиваем детерминированно по id,
  // чтобы каналы перемешались.
  if (!(await db.metaGet('tsCanonical'))) {
    status('Разовая миграция дат…');
    const all = await db.getAll('videos');
    const hash = (s) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return h;
    };
    for (const v of all) {
      const canon = canonicalPubTs(v.pubText, v.addedAt || Date.now());
      if (canon) {
        v.ts = canon.ts - (hash(v.id) % Math.max(1000, Math.floor(canon.g / 2)));
      }
    }
    await db.bulkPut('videos', all);
    await db.metaSet('tsCanonical', 1);
    status('');
  }

  // Синхронизация скрытого между устройствами (chrome.storage.sync)
  if (chrome.storage && chrome.storage.sync) {
    await pullHiddenSync();  // подтянуть с других устройств
    scheduleHiddenPush();    // выложить локальные, которых там ещё нет
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (!Object.keys(changes).some((k) => k.startsWith(SYNC_KEY_PREFIX))) return;
      pullHiddenSync().then((added) => {
        if (!added.length) return;
        for (const id of added) {
          const c = $('feed').querySelector(`.card[data-id="${id}"]`);
          if (c) c.remove();
        }
        refreshStats();
      });
    });
  }

  fillChannelFilter();
  await refreshStats();

  const firstRun = state.channels.size === 0;
  $('welcome').hidden = !firstRun;

  async function fullSync() {
    await syncChannels();
    fillChannelFilter();
    return quickSync();
  }

  // Автосинхронизация: лёгкая проверка ленты каждые 15 минут,
  // полный обход каналов — раз в 6 часов. Работает, пока страница открыта.
  async function autoTick() {
    if (state.syncing) return;
    const last = await db.metaGet('lastQuickSync', 0);
    if (Date.now() - last > FULL_SYNC_INTERVAL) {
      await runTask(fullSync, true);
    } else {
      await runTask(syncFeed, true);
    }
  }

  if (!firstRun) {
    resetFeed();
    autoTick(); // сразу при открытии
  }
  setInterval(autoTick, AUTO_FEED_INTERVAL);

  // Кнопки
  $('btnStart').onclick = () =>
    runTask(async () => {
      await syncChannels();
      fillChannelFilter();
      $('welcome').hidden = true;
      await quickSync();
      await importHistory();
    });
  $('btnSync').onclick = () => runTask(fullSync);
  $('btnFresh').onclick = () => {
    state.pendingNew = 0;
    $('btnFresh').hidden = true;
    window.scrollTo(0, 0);
    resetFeed();
  };
  $('btnHistory').onclick = () => runTask(importHistory);
  $('btnAbort').onclick = () => { state.abort = true; };
  $('btnChannels').onclick = () => {
    $('channelPanel').hidden = false;
    renderChannelPanel();
  };
  $('btnExport').onclick = () => exportBackup();
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => {
    const f = e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  };
  $('btnCloseChannels').onclick = () => { $('channelPanel').hidden = true; };
  let chSearchTimer = null;
  $('channelSearch').oninput = () => {
    clearTimeout(chSearchTimer);
    chSearchTimer = setTimeout(renderChannelPanel, 200);
  };

  // Фильтры
  $('hideWatched').onchange = (e) => {
    state.filters.hideWatched = e.target.checked;
    resetFeed();
  };
  let searchTimer = null;
  $('search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = e.target.value.trim().toLowerCase();
      resetFeed();
    }, 250);
  };
  $('channelFilter').onchange = (e) => {
    state.filters.channel = e.target.value;
    resetFeed();
  };

  // Бесконечная прокрутка
  new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting)) loadMore();
  }, { rootMargin: '1200px' }).observe($('sentinel'));
}

init();
