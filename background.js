// Background service worker: relays teleprompter content between tabs.
//
// When a tab turns "Persist" on it becomes the source. Its extracted text and
// scroll position are stored here (chrome.storage.session survives service
// worker restarts) and broadcast to all other tabs, which display them in a
// read-only "remote" prompter overlay.

const DEFAULT_STATE = {
  persist: false,
  sourceTabId: null,
  text: '',
  scrollFrac: 0,
};

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || { ...DEFAULT_STATE };
}

async function setState(state) {
  await chrome.storage.session.set({ state });
}

async function broadcast(msg, exceptTabId) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((t) => t.id !== undefined && t.id !== exceptTabId)
      .map((t) => chrome.tabs.sendMessage(t.id, msg))
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await getState();
    const tabId = sender.tab && sender.tab.id;

    switch (msg.type) {
      case 'persist-start':
        await setState({
          persist: true,
          sourceTabId: tabId,
          text: msg.text || '',
          scrollFrac: 0,
        });
        sendResponse({ ok: true });
        break;

      case 'persist-stop':
        await setState({ ...DEFAULT_STATE });
        await broadcast({ type: 'persist-ended' });
        sendResponse({ ok: true });
        break;

      case 'source-update': {
        if (!state.persist || tabId !== state.sourceTabId) {
          sendResponse({ ok: false });
          break;
        }
        const next = {
          ...state,
          text: typeof msg.text === 'string' ? msg.text : state.text,
          scrollFrac:
            typeof msg.scrollFrac === 'number' ? msg.scrollFrac : state.scrollFrac,
        };
        await setState(next);
        await broadcast(
          { type: 'remote-update', text: msg.text, scrollFrac: msg.scrollFrac },
          tabId
        );
        sendResponse({ ok: true });
        break;
      }

      case 'get-state':
        sendResponse({
          persist: state.persist,
          isSource: tabId === state.sourceTabId,
          text: state.text,
          scrollFrac: state.scrollFrac,
        });
        break;

      default:
        sendResponse({});
    }
  })();
  return true; // keep the message channel open for the async response
});

// If the source tab is closed, end persist mode everywhere.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.persist && tabId === state.sourceTabId) {
    await setState({ ...DEFAULT_STATE });
    await broadcast({ type: 'persist-ended' });
  }
});
