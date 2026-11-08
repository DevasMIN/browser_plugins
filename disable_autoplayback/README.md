# Youtube - NoAutoPlay 🛑

Chrome extension that blocks automatic video playback on YouTube when switching to a tab.

> **Language support:** 🇷🇺 Русский | 🇺🇸 English | 🇪🇸 Español

## Problem

When you have many YouTube tabs open, videos automatically start playing when you switch focus to one of them. This can be annoying and unexpected.

## Solution

This extension automatically blocks video playback when switching to a YouTube tab, giving you full control over when to start watching.

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right corner
3. Click "Load unpacked"
4. Select the `disable_autoplayback` folder

## Features

- ✅ Blocks autoplay when switching to tab
- ✅ Pauses the player right after the page loads (until you click/press a key; autoplay of the next video after one ends is left alone)
- ✅ Removes autoplay attribute from video elements
- ✅ Intercepts programmatic play attempts
- ✅ On/off toggle
- ✅ Works on all YouTube pages
- ✅ Beautiful control interface

## How It Works

The extension uses several methods to block autoplay:

1. **Tab visibility tracking** - detects when you switch to a tab
2. **Video state memory** - remembers which videos were playing BEFORE switching to another tab
3. **Smart blocking** - only stops videos that started playing automatically when returning to the tab
4. **play() method interception** - blocks programmatic playback calls (only automatic ones)
5. **Autoplay attribute removal** - prevents HTML5 autoplay
6. **MutationObserver** - tracks dynamically added video elements

**Important:** If a video was already playing before switching to another tab, it will continue playing when you return. Only NEW automatic playback is blocked.

## Usage

1. Install the extension
2. Open several YouTube tabs
3. Switch between tabs - videos won't play automatically
4. Click the extension icon to access settings
5. Use the toggle to enable/disable functionality

## Settings

- **Enable/Disable** - quick toggle for extension functionality

## Icon

The extension needs an icon to work. Create or use an `icons/icon.png` file with size 128x128 pixels, or use any image with a pause/stop symbol.

## Technical Information

- **Manifest Version**: 3
- **Permissions**: storage
- **Host Permissions**: *://*.youtube.com/*
- **Content Scripts**: Runs on all YouTube pages

## Notes

- Extension only works on YouTube
- Doesn't affect manual playback (when you press play yourself)
- Minimal performance impact
- Doesn't collect any data
