(() => {
  const EXTENSION_ID = "gemini-batch-exporter";
  const CHECKBOX_CLASS = "gbe-checkbox";
  const LINK_CLASS = "gbe-enhanced-link";
  const TOOLBAR_ID = "gbe-toolbar";

  const SELECTORS = {
    conversationLinks: [
      'a[href*="/app/"]',
      'a[href*="/chat/"]',
      'a[href*="/c/"]'
    ],
    userMessages: [
      "user-query",
      "[data-message-author-role='user']",
      ".user-query",
      ".query-text",
      ".user-message",
      "[class*='user-query']",
      "[class*='query-text']"
    ],
    modelMessages: [
      "model-response",
      "[data-message-author-role='model']",
      "[data-message-author-role='assistant']",
      ".model-response-text",
      ".response-container",
      ".markdown",
      "[class*='model-response']",
      "[class*='response-container']"
    ]
  };

  const state = {
    selected: new Map(),
    isExporting: false,
    observer: null
  };

  function absoluteUrl(href) {
    try {
      return new URL(href, location.origin).href;
    } catch {
      return "";
    }
  }

  function isConversationUrl(url) {
    try {
      const parsed = new URL(url);
      return /^\/app\/[^/?#]+/.test(parsed.pathname)
        || /^\/chat\/[^/?#]+/.test(parsed.pathname)
        || /^\/c\/[^/?#]+/.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function findConversationLinks() {
    const links = new Map();
    for (const selector of SELECTORS.conversationLinks) {
      for (const link of document.querySelectorAll(selector)) {
        const url = absoluteUrl(link.getAttribute("href"));
        if (!url || !url.includes(location.host)) continue;
        if (!isConversationUrl(url)) continue;
        if (url === location.href || url.includes("#")) continue;

        const title = cleanText(link.innerText || link.getAttribute("aria-label"));
        if (!title || title.length > 200) continue;

        links.set(url, { url, title, link });
      }
    }
    return [...links.values()];
  }

  function injectCheckboxes() {
    const conversations = findConversationLinks();
    for (const item of conversations) {
      if (item.link.querySelector(`.${CHECKBOX_CLASS}`)) continue;

      const wrap = document.createElement("span");
      wrap.className = "gbe-checkbox-wrap";
      wrap.title = "Select conversation for batch export";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = CHECKBOX_CLASS;
      checkbox.dataset.url = item.url;
      checkbox.dataset.title = item.title;
      checkbox.checked = state.selected.has(item.url);

      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener("change", (event) => {
        event.stopPropagation();
        if (checkbox.checked) {
          state.selected.set(item.url, { url: item.url, title: item.title });
        } else {
          state.selected.delete(item.url);
        }
        updateToolbar();
      });

      wrap.appendChild(checkbox);
      item.link.classList.add(LINK_CLASS);
      item.link.insertBefore(wrap, item.link.firstChild);
    }
    updateToolbar();
  }

  function ensureToolbar() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const toolbar = document.createElement("section");
    toolbar.id = TOOLBAR_ID;
    toolbar.className = "gbe-toolbar";
    toolbar.innerHTML = `
      <h2 class="gbe-toolbar__title">Gemini Batch Exporter</h2>
      <div class="gbe-toolbar__actions">
        <button class="gbe-button" data-action="select-all" type="button">Select loaded</button>
        <button class="gbe-button" data-action="clear" type="button">Clear</button>
        <button class="gbe-button gbe-button--primary" data-action="export" type="button">Export</button>
        <button class="gbe-button" data-action="cancel" type="button" hidden>Cancel</button>
      </div>
      <div class="gbe-format-panel" data-role="format-panel" hidden>
        <p class="gbe-format-panel__title">Choose export formats</p>
        <label><input type="checkbox" value="xlsx"> Excel</label>
        <label><input type="checkbox" value="docx"> Word</label>
        <label><input type="checkbox" value="pdf"> PDF</label>
        <label><input type="checkbox" value="md" checked> MD</label>
        <div class="gbe-toolbar__actions">
          <button class="gbe-button gbe-button--primary" data-action="confirm-export" type="button">Start</button>
          <button class="gbe-button" data-action="close-formats" type="button">Cancel</button>
        </div>
      </div>
      <p class="gbe-toolbar__status" data-role="status"></p>
    `;

    toolbar.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "select-all") selectAllLoaded();
      if (action === "clear") clearSelection();
      if (action === "export") openFormatPanel();
      if (action === "confirm-export") startExport();
      if (action === "close-formats") closeFormatPanel();
      if (action === "cancel") cancelExport();
    });

    document.documentElement.appendChild(toolbar);
    updateToolbar();
  }

  function updateToolbar(message) {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    const count = state.selected.size;
    const status = toolbar.querySelector("[data-role='status']");
    const exportButton = toolbar.querySelector("[data-action='export']");
    const cancelButton = toolbar.querySelector("[data-action='cancel']");
    const selectButton = toolbar.querySelector("[data-action='select-all']");
    const clearButton = toolbar.querySelector("[data-action='clear']");

    status.textContent = message || `${count} selected from the currently loaded history list.`;
    exportButton.disabled = count === 0 || state.isExporting;
    selectButton.disabled = state.isExporting;
    clearButton.disabled = state.isExporting;
    cancelButton.hidden = !state.isExporting;
  }

  function openFormatPanel() {
    const panel = document.querySelector("[data-role='format-panel']");
    if (!panel || !state.selected.size || state.isExporting) return;
    panel.hidden = false;
    updateToolbar("Choose one or more export formats.");
  }

  function closeFormatPanel() {
    const panel = document.querySelector("[data-role='format-panel']");
    if (panel) panel.hidden = true;
    updateToolbar();
  }

  function selectedFormats() {
    return [...document.querySelectorAll("[data-role='format-panel'] input[type='checkbox']:checked")]
      .map((input) => input.value);
  }

  function selectAllLoaded() {
    for (const item of findConversationLinks()) {
      state.selected.set(item.url, { url: item.url, title: item.title });
    }
    for (const checkbox of document.querySelectorAll(`.${CHECKBOX_CLASS}`)) {
      checkbox.checked = state.selected.has(checkbox.dataset.url);
    }
    updateToolbar();
  }

  function clearSelection() {
    state.selected.clear();
    for (const checkbox of document.querySelectorAll(`.${CHECKBOX_CLASS}`)) {
      checkbox.checked = false;
    }
    updateToolbar();
  }

  async function startExport() {
    if (!state.selected.size || state.isExporting) return;
    const formats = selectedFormats();
    if (!formats.length) {
      updateToolbar("Please select at least one export format.");
      return;
    }
    state.isExporting = true;
    closeFormatPanel();
    updateToolbar("Starting export...");
    chrome.runtime.sendMessage({
      type: "GBE_START_EXPORT",
      conversations: [...state.selected.values()],
      formats
    });
  }

  function cancelExport() {
    chrome.runtime.sendMessage({ type: "GBE_CANCEL_EXPORT" });
    state.isExporting = false;
    updateToolbar("Cancel requested. Finishing current step...");
  }

  function markdownFromNode(node) {
    const clone = node.cloneNode(true);
    for (const pre of clone.querySelectorAll("pre")) {
      const code = pre.innerText.replace(/\n+$/g, "");
      pre.replaceWith(document.createTextNode(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`));
    }
    for (const br of clone.querySelectorAll("br")) {
      br.replaceWith(document.createTextNode("\n"));
    }
    for (const link of clone.querySelectorAll("a[href]")) {
      const text = cleanText(link.innerText) || link.href;
      link.replaceWith(document.createTextNode(`${text} (${link.href})`));
    }
    for (const li of clone.querySelectorAll("li")) {
      li.insertBefore(document.createTextNode("- "), li.firstChild);
      li.appendChild(document.createTextNode("\n"));
    }
    return clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
  }

  function collectBySelectors(selectors, role) {
    const seen = new Set();
    const messages = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        const content = markdownFromNode(node);
        if (!content || content.length < 2) continue;
        seen.add(node);
        messages.push({ role, content, node });
      }
    }
    return messages;
  }

  function extractMessages() {
    const userMessages = collectBySelectors(SELECTORS.userMessages, "user");
    const modelMessages = collectBySelectors(SELECTORS.modelMessages, "model");
    const merged = [...userMessages, ...modelMessages]
      .sort((a, b) => {
        if (a.node === b.node) return 0;
        return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .map((message, index) => ({
        index,
        role: message.role,
        content: message.content
      }));

    const deduped = [];
    const seen = new Set();
    for (const message of merged) {
      const key = `${message.role}:${message.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...message, index: deduped.length });
    }
    return deduped;
  }

  function pageTitle(fallback) {
    const heading = document.querySelector("h1, [role='heading']");
    return cleanText(heading?.innerText) || cleanText(document.title.replace(/Gemini/i, "")) || fallback || "Gemini conversation";
  }

  async function waitForConversationContent(timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const messages = extractMessages();
      if (messages.length > 0) return messages;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [];
  }

  async function handleExtractConversation(request) {
    const messages = await waitForConversationContent();
    if (!messages.length) {
      throw new Error("No Gemini messages were found on this page. Gemini may not be loaded or its page structure changed.");
    }
    return {
      title: pageTitle(request.fallbackTitle),
      url: location.href,
      exportedAt: new Date().toISOString(),
      messages
    };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type === "GBE_EXPORT_PROGRESS") {
      state.isExporting = !request.done;
      updateToolbar(request.message);
      sendResponse({ ok: true });
      return false;
    }

    if (request?.type === "GBE_EXTRACT_CONVERSATION") {
      handleExtractConversation(request)
        .then((conversation) => sendResponse({ ok: true, conversation }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  });

  function boot() {
    ensureToolbar();
    injectCheckboxes();
    state.observer = new MutationObserver(() => {
      window.clearTimeout(boot._timer);
      boot._timer = window.setTimeout(injectCheckboxes, 300);
    });
    state.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  if (!window[EXTENSION_ID]) {
    window[EXTENSION_ID] = true;
    boot();
  }
})();
