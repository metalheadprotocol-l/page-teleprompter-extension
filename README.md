# Page Teleprompter (Chrome extension)

Turns the text of the **current webpage** into a floating, auto-scrolling
teleprompter overlay. No pasting needed — it extracts the page's readable text
directly, and can keep syncing while the page updates (live transcripts,
chats, captions).

## Install (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this repository folder.
4. Pin the extension, open any page, click the icon, then **Show / hide teleprompter**.

## Usage

- **Whole page**: just click the toolbar button. The extension grabs the main
  article/content area (falls back to the full body).
- **Part of a page**: select the text you want first, then toggle the
  overlay — only your selection is prompted.
- **Play / Pause** starts and stops auto-scroll (Space bar also works while
  the overlay is focused). Adjust **Speed** and **Size** with the sliders.
- **Reload** re-reads the page text from scratch.
- **Live: on/off** — when on, a MutationObserver watches the page; any new
  text (e.g. a live transcript appending lines) streams into the prompter,
  highlighted briefly in blue.
- **Sync: on/off** — when on, scrolling the webpage scrolls the prompter in
  real time (proportional position mapping; works for the window and inner
  scrollable panels). While Play is running, incoming sync is ignored so the
  two never fight; pause to resume following the page.
- **Persist: on/off** — the tab where you enable Persist becomes the source.
  Switch to any other tab and the prompter automatically appears there,
  streaming the source tab's text (and its scrolling) live. Turn Persist off
  from any tab and every overlay returns to its own page's content. Closing
  the source tab or its overlay also ends Persist.
- **Mirror** flips the text horizontally for beam-splitter teleprompter rigs.
- **Hide ctrls / Show ctrls** collapses the bottom bar (speed/size sliders)
  for a cleaner, smaller prompter window.
- Drag the header to move, drag the bottom-right corner to resize. The
  control bars stay visible at any size; sliders wrap to a second row on
  narrow windows.

## How it works

- `content.js` runs on every page. On toggle it clones the main content
  element, strips non-readable nodes (nav, scripts, buttons, hidden
  elements...), and renders the remaining text into the overlay.
- With Live sync on, a debounced `MutationObserver` re-extracts the text on
  DOM changes. If the new text simply extends the old text (typical for live
  transcript pages), only the new tail is appended so your reading position
  is never lost.
- Auto-scroll uses `requestAnimationFrame` for smooth, per-pixel scrolling at
  an adjustable px/second rate.
- Persist mode is coordinated by `background.js` (a service worker): the
  source tab pushes its extracted text and scroll fraction, the worker caches
  them in `chrome.storage.session` (so state survives worker restarts) and
  relays updates to every other tab, where the overlay renders in a "remote"
  mode with page-specific controls (Reload/Live) hidden.

## Limitations

- Does not run on `chrome://` pages, the Chrome Web Store, or PDFs.
- Text inside cross-origin iframes (e.g. some embedded players/captions)
  is not accessible to content scripts.
- Extraction is heuristic; on cluttered pages, select the text you want first
  for a clean prompt.
