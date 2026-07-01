// Page Teleprompter - content script
// Extracts the current page's text (or the user's selection) and shows it
// in a floating auto-scrolling teleprompter overlay. With live sync enabled,
// a MutationObserver re-extracts text as the page changes, so pages that
// update in real time (live transcripts, chats, captions) stream into the
// prompter automatically.

(() => {
  if (window.__ltpLoaded) return;
  window.__ltpLoaded = true;

  let overlay = null;
  let viewport = null;
  let textEl = null;
  let statusEl = null;
  let playBtn = null;

  let sourceEl = null;        // element we extract text from
  let observer = null;        // MutationObserver for live sync
  let liveSync = true;
  let scrollSync = false;     // mirror page scrolling into the prompter
  let scrolling = false;
  let speed = 40;             // px per second
  let rafId = null;
  let lastTs = 0;
  let scrollRemainder = 0;
  let refreshTimer = null;

  // ---------- text extraction ----------

  const STRIP_SELECTOR =
    'script,style,noscript,svg,canvas,iframe,nav,header,footer,aside,form,button,input,select,textarea,[aria-hidden="true"],[hidden]';

  function pickSourceElement() {
    const candidates = [
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.body,
    ].filter(Boolean);

    // Prefer the first candidate that has a reasonable amount of text.
    for (const el of candidates) {
      const len = (el.innerText || '').trim().length;
      if (len > 200) return el;
    }
    return document.body;
  }

  function extractFrom(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(STRIP_SELECTOR).forEach((n) => n.remove());
    // Remove our own overlay if it got cloned (when source is <body>).
    clone.querySelectorAll('#ltp-overlay').forEach((n) => n.remove());
    const raw = clone.innerText || '';
    // Collapse 3+ newlines into 2, trim trailing spaces per line.
    return raw
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

  // ---------- rendering ----------

  function setText(newText, { append = false } = {}) {
    if (!textEl) return;
    if (append) {
      const span = document.createElement('span');
      span.className = 'ltp-new';
      span.textContent = newText;
      textEl.appendChild(span);
      // Fade the highlight after a moment.
      setTimeout(() => span.classList.remove('ltp-new'), 1500);
    } else {
      textEl.textContent = newText;
    }
  }

  function updateFromSource() {
    if (!sourceEl || !textEl) return;
    const fresh = extractFrom(sourceEl);
    const current = textEl.textContent;
    if (fresh === current) return;

    if (fresh.startsWith(current) && current.length > 0) {
      // Page grew (live transcript case): append only the new tail so the
      // reader's scroll position is preserved.
      const wasAtBottom =
        viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 60;
      setText(fresh.slice(current.length), { append: true });
      if (wasAtBottom && !scrolling) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      setStatus('live: +' + (fresh.length - current.length) + ' chars');
    } else {
      const keepScroll = viewport.scrollTop;
      setText(fresh);
      viewport.scrollTop = keepScroll;
      setStatus('live: refreshed');
    }
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  // ---------- live sync ----------

  function startObserver() {
    stopObserver();
    if (!sourceEl) return;
    observer = new MutationObserver(() => {
      // Debounce bursts of DOM changes.
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(updateFromSource, 400);
    });
    observer.observe(sourceEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(refreshTimer);
  }

  // ---------- page scroll sync ----------

  function onPageScroll(e) {
    if (!viewport || !overlay) return;
    const el =
      e.target === document || e.target === window
        ? document.scrollingElement
        : e.target;
    if (!el || !(el instanceof Element)) return;
    // Ignore scrolls that happen inside our own overlay.
    if (overlay.contains(el)) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const frac = el.scrollTop / max;
    viewport.scrollTop =
      frac * (viewport.scrollHeight - viewport.clientHeight);
  }

  function startScrollSync() {
    // Capture phase so we also catch scrolls of inner containers
    // (scroll events don't bubble from regular elements).
    window.addEventListener('scroll', onPageScroll, true);
  }

  function stopScrollSync() {
    window.removeEventListener('scroll', onPageScroll, true);
  }

  // ---------- auto-scroll ----------

  function tick(ts) {
    if (!scrolling) return;
    if (lastTs) {
      const delta = ((ts - lastTs) / 1000) * speed + scrollRemainder;
      const px = Math.floor(delta);
      scrollRemainder = delta - px;
      if (px > 0) viewport.scrollTop += px;
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) {
        // Reached the end; keep running in live mode (new text may arrive).
        if (!liveSync) toggleScroll(false);
      }
    }
    lastTs = ts;
    rafId = requestAnimationFrame(tick);
  }

  function toggleScroll(on) {
    scrolling = on === undefined ? !scrolling : on;
    if (scrolling && scrollSync) {
      // Auto-scroll takes over: drop page sync so they don't fight.
      scrollSync = false;
      stopScrollSync();
      const syncBtn = overlay && overlay.querySelector('#ltp-sync');
      if (syncBtn) syncBtn.textContent = 'Sync: off';
    }
    if (playBtn) {
      playBtn.textContent = scrolling ? 'Pause' : 'Play';
      playBtn.classList.toggle('ltp-active', scrolling);
    }
    lastTs = 0;
    scrollRemainder = 0;
    if (scrolling) {
      rafId = requestAnimationFrame(tick);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ---------- overlay UI ----------

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'ltp-overlay';
    overlay.innerHTML = `
      <div id="ltp-header">
        <span id="ltp-title">Teleprompter</span>
        <button class="ltp-btn" id="ltp-play">Play</button>
        <button class="ltp-btn" id="ltp-reload" title="Re-read page text">Reload</button>
        <button class="ltp-btn" id="ltp-live" title="Keep syncing as the page changes">Live: on</button>
        <button class="ltp-btn" id="ltp-sync" title="Scroll the prompter in sync with the page">Sync: off</button>
        <button class="ltp-btn" id="ltp-mirror" title="Mirror for beam-splitter glass">Mirror</button>
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
      <div id="ltp-resize"></div>
    `;
    document.documentElement.appendChild(overlay);

    viewport = overlay.querySelector('#ltp-viewport');
    textEl = overlay.querySelector('#ltp-text');
    statusEl = overlay.querySelector('#ltp-status');
    playBtn = overlay.querySelector('#ltp-play');

    playBtn.addEventListener('click', () => toggleScroll());
    overlay.querySelector('#ltp-close').addEventListener('click', destroy);
    overlay.querySelector('#ltp-mirror').addEventListener('click', () => {
      overlay.classList.toggle('ltp-mirrored');
    });
    overlay.querySelector('#ltp-ctrls').addEventListener('click', (e) => {
      const hidden = overlay.classList.toggle('ltp-controls-hidden');
      e.target.textContent = hidden ? 'Show ctrls' : 'Hide ctrls';
    });
    overlay.querySelector('#ltp-reload').addEventListener('click', () => {
      loadSource();
    });
    overlay.querySelector('#ltp-live').addEventListener('click', (e) => {
      liveSync = !liveSync;
      e.target.textContent = liveSync ? 'Live: on' : 'Live: off';
      if (liveSync) startObserver();
      else stopObserver();
    });
    overlay.querySelector('#ltp-sync').addEventListener('click', (e) => {
      scrollSync = !scrollSync;
      e.target.textContent = scrollSync ? 'Sync: on' : 'Sync: off';
      if (scrollSync) {
        toggleScroll(false); // auto-scroll would fight the page sync
        startScrollSync();
        onPageScroll({ target: document }); // align immediately
        setStatus('scroll sync on');
      } else {
        stopScrollSync();
        setStatus('scroll sync off');
      }
    });
    overlay.querySelector('#ltp-speed').addEventListener('input', (e) => {
      speed = Number(e.target.value);
    });
    overlay.querySelector('#ltp-size').addEventListener('input', (e) => {
      textEl.style.fontSize = e.target.value + 'px';
    });

    makeDraggable(overlay.querySelector('#ltp-header'));
    makeResizable(overlay.querySelector('#ltp-resize'));

    // Space bar toggles scrolling while hovering the overlay.
    overlay.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        toggleScroll();
      }
    });
    overlay.tabIndex = -1;
  }

  function makeDraggable(handle) {
    let sx, sy, ox, oy;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ltp-btn')) return;
      e.preventDefault();
      const rect = overlay.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      ox = rect.left;
      oy = rect.top;
      overlay.style.transform = 'none';
      const move = (ev) => {
        overlay.style.left = ox + (ev.clientX - sx) + 'px';
        overlay.style.top = oy + (ev.clientY - sy) + 'px';
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
      const rect = overlay.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev) => {
        overlay.style.width = Math.max(280, rect.width + ev.clientX - sx) + 'px';
        overlay.style.height = Math.max(140, rect.height + ev.clientY - sy) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // ---------- lifecycle ----------

  function loadSource() {
    const selText = getSelectionText();
    if (selText) {
      // Selection mode: static text, anchor live sync to the selection's
      // common ancestor so updates inside it still flow.
      const sel = window.getSelection();
      const anchor = sel.getRangeAt(0).commonAncestorContainer;
      sourceEl =
        anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      setText(selText);
      setStatus('source: selection');
    } else {
      sourceEl = pickSourceElement();
      setText(extractFrom(sourceEl));
      setStatus(
        'source: ' +
          (sourceEl.tagName === 'BODY' ? 'page' : sourceEl.tagName.toLowerCase())
      );
    }
    viewport.scrollTop = 0;
    if (liveSync) startObserver();
  }

  function show() {
    if (!overlay) {
      buildOverlay();
      loadSource();
    } else {
      overlay.style.display = 'flex';
    }
  }

  function destroy() {
    toggleScroll(false);
    stopObserver();
    stopScrollSync();
    scrollSync = false;
    if (overlay) {
      overlay.remove();
      overlay = null;
      viewport = textEl = statusEl = playBtn = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'toggle') {
      if (overlay && overlay.style.display !== 'none') destroy();
      else show();
      sendResponse({ visible: !!overlay });
    }
    return true;
  });
})();
