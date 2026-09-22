# YouTube Deep Feed (Firefox)

Порт [youtube_deep_feed](../youtube_deep_feed) под Firefox. Опубликован на AMO
(addons.mozilla.org) как self-distributed unlisted-дополнение, id
`youtube-deep-feed@local`.

## Чем отличается от Chrome/Opera-версии

- **Переписывание Origin/Referer:** вместо `declarativeNetRequest` (ненадёжен
  в Firefox для сессионных правил) используется классический блокирующий
  `webRequest` + `webRequestBlocking` (`background.js`). Firefox продолжает
  поддерживать его в MV3.
- **`browser.*` / `chrome.*` полифил:** везде `const browserAPI = typeof
  browser !== 'undefined' ? browser : chrome`.
- **ID через `browser_specific_settings.gecko.id`**, а не через `key`
  (у Firefox нет эквивалента полю `key` из Chrome-манифеста).
- **`background.scripts` как фолбэк** рядом с `service_worker` — Firefox
  требует его для MV3-расширений.
- `host_permissions` включает `i.ytimg.com` (нужно для запросов, которых нет
  в Chrome-варианте).
- Нет `open_feed.html` (трамплин для Экспресс-панели Opera — там был захардкожен
  `chrome-extension://` ID; для Firefox это неприменимо, `moz-extension://` ID
  расширения другой и генерируется иначе).

## История

Восстановлено из уже поданных на AMO версий (0.9.19 → 0.9.21 → 0.9.23) — сама
разработка этого порта шла в отдельной части сессии, результат которой не
попал в git до 2026-09-21. Считать код в этой папке независимо развившейся
веткой относительно [youtube_deep_feed](../youtube_deep_feed): часть фич и
исправлений есть только тут, часть — только там. Объединение веток в этом
коммите не делалось.

После восстановления портированы точечные фичи из Chrome-версии без полного
слияния веток:
- **0.9.24** — фоновая ротация каналов + живой показ новых видео вместо
  разового обхода всех каналов раз в 6ч.
- **0.9.25** — кнопка «🎲 3 случайных» (3 случайных видео вместо всей ленты,
  новая тройка по повторному клику или автоматически при скрытии/просмотре
  всех трёх) и «↩ Вся лента».

## Установка (для тестирования до публикации)

`about:debugging#/runtime/this-firefox` → «Load Temporary Add-on…» → выбрать
`manifest.json`. Для постоянной установки без подписи — Firefox Developer
Edition/Nightly/ESR с `xpinstall.signatures.required=false`, либо ставить уже
подписанный `.xpi` с AMO.
