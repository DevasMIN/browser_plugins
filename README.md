# Browser Plugins Collection

Collection of useful Chrome extensions with multi-language support.

> **Languages:** 🇷🇺 Русский | 🇺🇸 English | 🇪🇸 Español

## 🔌 Plugins

### 1. SpeedPlayBack ⚡
**Folder:** `video_speed_controller/`

Control video playback speed with customizable presets and keyboard shortcuts.

**Features:**
- ✅ Customizable speed presets
- ✅ Keyboard shortcuts for quick switching
- ✅ Three application scopes: tab, domain, all tabs
- ✅ Beautiful gradient interface
- ✅ Support for all videos on any website

### 2. Youtube - NoAutoPlay 🛑
**Folder:** `disable_autoplayback/`

Blocks automatic video playback on YouTube when switching to a tab.

**Features:**
- ✅ Smart autoplay blocking
- ✅ Doesn't stop videos that were already playing
- ✅ Removes autoplay attribute
- ✅ On/off toggle
- ✅ Minimal performance impact

### 3. YouTube Deep Feed 📜
**Folder:** `youtube_deep_feed/`

Own infinite chronological feed for all YouTube subscriptions — replaces the
truncated native `/feed/subscriptions`.

**Features:**
- ✅ Full channel archives cached locally (IndexedDB)
- ✅ Watched marks imported from YouTube history and progress bars
- ✅ Hide videos or whole channels
- ✅ Incremental sync of new videos
- ✅ Search and per-channel filter

## 🌐 Language Support

All plugins support:
- 🇷🇺 Russian (default)
- 🇺🇸 English
- 🇪🇸 Spanish

Language is selected automatically based on browser language.

## 📦 Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right corner
3. Click "Load unpacked"
4. Select the plugin folder (`video_speed_controller/` or `disable_autoplayback/`)

## 🛠️ Technologies

- **Manifest V3** - modern Chrome Extensions standard
- **Chrome i18n API** - internationalization
- **WeakMap** - efficient element state tracking
- **Chrome Storage API** - settings persistence
- **Content Scripts** - page interaction

## 📝 Project Structure

```
browser_plugins/
├── video_speed_controller/    # SpeedPlayBack
│   ├── _locales/              # Translations (ru, en, es)
│   ├── icons/                 # Icons
│   ├── manifest.json          # Configuration
│   ├── popup.html/css/js      # Interface
│   ├── content.js             # Page scripts
│   └── background.js          # Background service
│
├── disable_autoplayback/      # Youtube - NoAutoPlay
│   ├── _locales/              # Translations (ru, en, es)
│   ├── icons/                 # Icons
│   ├── manifest.json          # Configuration
│   ├── popup.html/css/js      # Interface
│   └── content.js             # Page scripts
│
└── README.md                  # This file
```

## 🤝 Contributing

Project is open for improvements and suggestions!

## 📄 License

MIT License

---

Made with ❤️ for better browsing experience
