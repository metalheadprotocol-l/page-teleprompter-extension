// Page Teleprompter - content script
//
// Modes:
//   local  - prompts the current page's text (default). "Live" keeps it
//            synced with page changes via a MutationObserver.
//   remote - prompts text streamed from another tab. Entered automatically
//            when some other tab has "Persist" turned on.
//
// Persist: the tab where Persist is enabled becomes the source. Its text and
// page scroll position are relayed through the background service worker to
// every other tab, so the same prompter content follows you across tabs.
// Turning Persist off returns every overlay to its own page's content.

(() => {
  if (window.__ltpLoaded) return;
  window.__ltpLoaded = true;

  // ------------------------------------------------------------- state --

  const ui = {
    overlay: null,
    viewport: null,
    text: null,
    status: null,
    title: null,
    buttons: {}, // play, reload, live, sync, persist, ctrls
  };

  const state = {
    mode: 'local',          // 'local' | 'remote'
    sourceEl: null,         // element text is extracted from (local mode)
    observer: null,         // MutationObserver for Live sync
    refreshTimer: null,
    liveSync: true,         // follow page DOM changes (local mode)
    scrollSync: false,      // follow page scrolling
    persist: false,         // this tab is broadcasting to other tabs
    pageScrollAttached: false,
    scrolling: false,       // auto-scroll (Play) active
    speed: 40,              // auto-scroll px per second
    rafId: null,
    lastTs: 0,
    scrollRemainder: 0,
    lastScrollBroadcast: 0,
  };

  // --------------------------------------------------------- messaging --

  async function sendBg(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return null; // background unavailable (e.g. extension reloaded)
    }
  }

  // --------------------------------------------------- text extraction --

  const STRIP_SELECTOR =
    'script,style,noscript,svg,canvas,iframe,nav,header,footer,aside,form,button,input,select,textarea,[aria-hidden="true"],[hidden]';

  function pickSourceElement() {
    const candidates = [
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.body,
    ].filter(Boolean);

    for (const el of candidates) {
      if ((el.innerText || '').trim().length > 200) return el;
    }
    return document.body;
  }

  function extractFrom(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(STRIP_SELECTOR).forEach((n) => n.remove());
    clone.querySelectorAll('#ltp-overlay').forEach((n) => n.remove());
    return (clone.innerText || '')
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getSelectionText() {
    const sel = window.getSelection();
    return sel && !sel.isCollapsed ? sel.toString().trim() : '';
  }

  // ---------------------------------------------------------- rendering --

  function setStatus(msg) {
    if (ui.status) ui.status.textContent = msg;
  }

  function replaceText(text) {
    if (ui.text) ui.text.textContent = text;
  }

  function appendText(tail) {
    const span = document.createElement('span');
    span.className = 'ltp-new';
    span.textContent = tail;
    ui.text.appendChild(span);
    setTimeout(() => span.classList.remove('ltp-new'), 1500);
  }

  // Append-aware update: if the new text extends the old (live transcripts),
  // only the tail is added so the reading position is preserved.
  function applyIncomingText(fresh) {
    if (!ui.text) return;
    const current = ui.text.textContent;
    if (fresh === current) return;

    if (current && fresh.startsWith(current)) {
      const wasAtBottom =
        ui.viewport.scrollTop + ui.viewport.clientHeight >=
        ui.viewport.scrollHeight - 60;
      appendText(fresh.slice(current.length));
      if (wasAtBottom && !state.scrolling) {
        ui.viewport.scrollTop = ui.viewport.scrollHeight;
      }
      setStatus('live: +' + (fresh.length - current.length) + ' chars');
    } else {
      const keepScroll = ui.viewport.scrollTop;
      replaceText(fresh);
      ui.viewport.scrollTop = keepScroll;
      setStatus('live: refreshed');
    }
  }

  function applyScrollFrac(frac) {
    if (!ui.viewport) return;
    ui.viewport.scrollTop =
      frac * (ui.viewport.scrollHeight - ui.viewport.clientHeight);
  }

  // --------------------------------------------- local mode (this page) --

  function loadLocalSource() {
    const selText = getSelectionText();
    if (selText) {
      const anchor = window.getSelection().getRangeAt(0).commonAncestorContainer;
      state.sourceEl =
        anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      replaceText(selText);
      setStatus('source: selection');
    } else {
      state.sourceEl = pickSourceElement();
      replaceText(extractFrom(state.sourceEl));
      setStatus(
        'source: ' +
          (state.sourceEl.tagName === 'BODY'
            ? 'page'
            : state.sourceEl.tagName.toLowerCase())
      );
    }
    ui.viewport.scrollTop = 0;
    if (state.liveSync) startObserver();
    if (state.persist) broadcastText();
  }

  function updateFromSource() {
    if (!state.sourceEl || state.mode !== 'local') return;
    applyIncomingText(extractFrom(state.sourceEl));
    if (state.persist) broadcastText();
  }

  function startObserver() {
    stopObserver();
    if (!state.sourceEl) return;
    state.observer = new MutationObserver(() => {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = setTimeout(updateFromSource, 400);
    });
    state.observer.observe(state.sourceEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.refreshTimer);
  }

  // ------------------------------------------- page scroll (sync + persist)

  function onPageScroll(e) {
    const el =
      e.target === document || e.target === window
        ? document.scrollingElement
        : e.target;
    if (!(el instanceof Element)) return;
    if (ui.overlay && ui.overlay.contains(el)) return; // our own overlay

    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const frac = el.scrollTop / max;

    // Follow the page locally (unless auto-scroll is driving).
    if (state.scrollSync && state.mode === 'local' && !state.scrolling) {
      applyScrollFrac(frac);
    }
    // Relay to other tabs (throttled).
    if (state.persist) {
      const now = Date.now();
      if (now - state.lastScrollBroadcast > 150) {
        state.lastScrollBroadcast = now;
        sendBg({ type: 'source-update', scrollFrac: frac });
      }
    }
  }

  function updatePageScrollListener() {
    const need =
      (state.scrollSync && state.mode === 'local') || state.persist;
    if (need && !state.pageScrollAttached) {
      // Capture phase also catches scrolls of inner containers.
      window.addEventListener('scroll', onPageScroll, true);
      state.pageScrollAttached = true;
    } else if (!need && state.pageScrollAttached) {
      window.removeEventListener('scroll', onPageScroll, true);
      state.pageScrollAttached = false;
    }
  }

  // ------------------------------------------------- persist (broadcast) --

  function broadcastText() {
    sendBg({ type: 'source-update', text: ui.text ? ui.text.textContent : '' });
  }

  async function onPersistClicked() {
    if (state.persist || state.mode === 'remote') {
      await sendBg({ type: 'persist-stop' });
      endPersistLocally(); // persist-ended broadcast handles the other tabs
    } else {
      await sendBg({
        type: 'persist-start',
        text: ui.text ? ui.text.textContent : '',
      });
      state.persist = true;
      ui.buttons.persist.textContent = 'Persist: on';
      updatePageScrollListener();
      setStatus('persist on: streaming this tab');
    }
  }

  function endPersistLocally() {
    state.persist = false;
    if (ui.buttons.persist) ui.buttons.persist.textContent = 'Persist: off';
    if (state.mode === 'remote') exitRemoteToLocal();
    updatePageScrollListener();
    setStatus('persist off');
  }

  // ------------------------------------------ remote mode (other tab's text)

  function enterRemoteMode(text, scrollFrac) {
    if (!ui.overlay) buildOverlay();
    ui.overlay.style.display = 'flex';
    state.mode = 'remote';
    stopObserver();

    state.scrollSync = true; // follow the source tab's scrolling by default
    ui.buttons.sync.textContent = 'Sync: on';
    ui.buttons.reload.style.display = 'none';
    ui.buttons.live.style.display = 'none';
    ui.buttons.persist.textContent = 'Persist: on';
    ui.title.textContent = 'Teleprompter - remote';

    replaceText(text || '');
    if (typeof scrollFrac === 'number') applyScrollFrac(scrollFrac);
    setStatus('streaming from another tab');
    updatePageScrollListener();
  }

  function exitRemoteToLocal() {
    state.mode = 'local';
    ui.buttons.reload.style.display = '';
    ui.buttons.live.style.display = '';
    ui.buttons.persist.textContent = 'Persist: off';
    ui.title.textContent = 'Teleprompter';
    loadLocalSource();
    updatePageScrollListener();
  }

  function onRemoteUpdate(msg) {
    if (state.mode !== 'remote' || !ui.overlay) return;
    if (typeof msg.text === 'string') applyIncomingText(msg.text);
    if (
      typeof msg.scrollFrac === 'number' &&
      state.scrollSync &&
      !state.scrolling
    ) {
      applyScrollFrac(msg.scrollFrac);
    }
  }

  // -------------------------------------------------------- auto-scroll --

  function tick(ts) {
    if (!state.scrolling) return;
    if (state.lastTs) {
      const delta =
        ((ts - state.lastTs) / 1000) * state.speed + state.scrollRemainder;
      const px = Math.floor(delta);
      state.scrollRemainder = delta - px;
      if (px > 0) ui.viewport.scrollTop += px;
    }
    state.lastTs = ts;
    state.rafId = requestAnimationFrame(tick);
  }

  function toggleScroll(on) {
    state.scrolling = on === undefined ? !state.scrolling : on;
    if (ui.buttons.play) {
      ui.buttons.play.textContent = state.scrolling ? 'Pause' : 'Play';
      ui.buttons.play.classList.toggle('ltp-active', state.scrolling);
    }
    state.lastTs = 0;
    state.scrollRemainder = 0;
    if (state.scrolling) {
      state.rafId = requestAnimationFrame(tick);
    } else if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  }

  // --------------------------------------------------------- overlay UI --

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'ltp-overlay';
    overlay.innerHTML = `
      <div id="ltp-header">
        <span id="ltp-title">Teleprompter</span>
        <button class="ltp-btn" id="ltp-play">Play</button>
        <button class="ltp-btn" id="ltp-reload" title="Re-read page text">Reload</button>
        <button class="ltp-btn" id="ltp-live" title="Keep syncing as the page changes">Live: on</button>
        <button class="ltp-btn" id="ltp-sync" title="Scroll the prompter in sync with the page">Sync: off</button>
        <button class="ltp-btn" id="ltp-persist" title="Keep streaming this tab's text when you switch tabs">Persist: off</button>
        <button class="ltp-btn" id="ltp-ctrls" title="Hide or show the speed/size controls">Hide ctrls</button>
        <button class="ltp-btn" id="ltp-close">X</button>
      </div>
      <div id="ltp-viewport"><div id="ltp-text"></div></div>
      <div id="ltp-footer">
        <span class="ltp-slider-label">Speed</span>
        <input type="range" id="ltp-speed" min="5" max="200" value="40">
        <span class="ltp-slider-label">Size</span>
        <input type="range" id="ltp-size" min="14" max="72" value="28">
        <span id="ltp-status"></span>
      </div>
      <div class="ltp-edge" id="ltp-edge-left"></div>
      <div class="ltp-edge" id="ltp-edge-right"></div>
      <div class="ltp-edge" id="ltp-edge-bottom"></div>
      <div id="ltp-resize"></div>
    `;
    document.documentElement.appendChild(overlay);

    ui.overlay = overlay;
    ui.viewport = overlay.querySelector('#ltp-viewport');
    ui.text = overlay.querySelector('#ltp-text');
    ui.status = overlay.querySelector('#ltp-status');
    ui.title = overlay.querySelector('#ltp-title');
    ui.buttons = {
      play: overlay.querySelector('#ltp-play'),
      reload: overlay.querySelector('#ltp-reload'),
      live: overlay.querySelector('#ltp-live'),
      sync: overlay.querySelector('#ltp-sync'),
      persist: overlay.querySelector('#ltp-persist'),
      ctrls: overlay.querySelector('#ltp-ctrls'),
    };

    ui.buttons.play.addEventListener('click', () => toggleScroll());
    ui.buttons.reload.addEventListener('click', loadLocalSource);
    ui.buttons.live.addEventListener('click', (e) => {
      state.liveSync = !state.liveSync;
      e.target.textContent = state.liveSync ? 'Live: on' : 'Live: off';
      if (state.liveSync) startObserver();
      else stopObserver();
    });
    ui.buttons.sync.addEventListener('click', (e) => {
      state.scrollSync = !state.scrollSync;
      e.target.textContent = state.scrollSync ? 'Sync: on' : 'Sync: off';
      updatePageScrollListener();
    });
    ui.buttons.persist.addEventListener('click', onPersistClicked);
    ui.buttons.ctrls.addEventListener('click', (e) => {
      const hidden = ui.overlay.classList.toggle('ltp-controls-hidden');
      e.target.textContent = hidden ? 'Show ctrls' : 'Hide ctrls';
    });
    overlay.querySelector('#ltp-close').addEventListener('click', destroy);
    overlay.querySelector('#ltp-speed').addEventListener('input', (e) => {
      state.speed = Number(e.target.value);
    });
    overlay.querySelector('#ltp-size').addEventListener('input', (e) => {
      ui.text.style.fontSize = e.target.value + 'px';
    });

    makeDraggable(overlay.querySelector('#ltp-header'));
    overlay.querySelectorAll('.ltp-edge').forEach(makeDraggable);
    makeResizable(overlay.querySelector('#ltp-resize'));

    overlay.tabIndex = -1;
    overlay.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        toggleScroll();
      }
    });
  }

  function makeDraggable(handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ltp-btn')) return;
      e.preventDefault();
      const rect = ui.overlay.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      ui.overlay.style.transform = 'none';
      const move = (ev) => {
        ui.overlay.style.left = rect.left + (ev.clientX - sx) + 'px';
        ui.overlay.style.top = rect.top + (ev.clientY - sy) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function makeResizable(handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = ui.overlay.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev) => {
        ui.overlay.style.width =
          Math.max(280, rect.width + ev.clientX - sx) + 'px';
        ui.overlay.style.height =
          Math.max(140, rect.height + ev.clientY - sy) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // ----------------------------------------------------------- lifecycle --

  async function showAuto() {
    const st = await sendBg({ type: 'get-state' });
    if (st && st.persist && !st.isSource) {
      enterRemoteMode(st.text, st.scrollFrac);
    } else {
      if (!ui.overlay) {
        buildOverlay();
        loadLocalSource();
      } else {
        ui.overlay.style.display = 'flex';
      }
    }
  }

  function destroy() {
    if (state.persist) sendBg({ type: 'persist-stop' });
    state.persist = false;
    state.mode = 'local';
    toggleScroll(false);
    stopObserver();
    updatePageScrollListener();
    if (ui.overlay) {
      ui.overlay.remove();
      ui.overlay = ui.viewport = ui.text = ui.status = ui.title = null;
      ui.buttons = {};
    }
  }

  // --------------------------------------------------------- message router

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type || msg.action) {
      case 'toggle':
        if (ui.overlay && ui.overlay.style.display !== 'none') destroy();
        else showAuto();
        sendResponse({ visible: !!ui.overlay });
        break;
      case 'remote-update':
        onRemoteUpdate(msg);
        sendResponse({});
        break;
      case 'persist-ended':
        if (state.persist || state.mode === 'remote') endPersistLocally();
        sendResponse({});
        break;
      default:
        sendResponse({});
    }
    return true;
  });

  // Auto-open the remote prompter when this tab becomes visible while
  // another tab is persisting.
  async function maybeAutoOpenRemote() {
    const st = await sendBg({ type: 'get-state' });
    if (!st || !st.persist || st.isSource) return;
    if (state.mode === 'remote' && ui.overlay) {
      applyIncomingText(st.text); // catch up on anything missed while hidden
    } else if (!ui.overlay) {
      enterRemoteMode(st.text, st.scrollFrac);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeAutoOpenRemote();
  });
  if (document.visibilityState === 'visible') maybeAutoOpenRemote();
})();
