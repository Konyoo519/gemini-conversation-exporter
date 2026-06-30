const state = {
  cancelled: false,
  running: false,
  sourceTabId: null,
  workerTabId: null
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === "GBE_START_EXPORT") {
    if (state.running) {
      sendResponse({ ok: false, error: "An export is already running." });
      return false;
    }
    state.sourceTabId = sender.tab?.id;
    runExport(request.conversations || [], request.formats || ["md"]);
    sendResponse({ ok: true });
    return false;
  }

  if (request?.type === "GBE_CANCEL_EXPORT") {
    state.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function runExport(conversations, formats) {
  state.running = true;
  state.cancelled = false;
  const results = [];
  const failures = [];

  try {
    if (!conversations.length) {
      await notifySource("No conversations selected.", true);
      return;
    }

    for (let i = 0; i < conversations.length; i += 1) {
      if (state.cancelled) break;
      const item = conversations[i];
      await notifySource(`Exporting ${i + 1}/${conversations.length}: ${item.title}`);
      try {
        const conversation = await extractFromWorkerTab(item);
        results.push(conversation);
      } catch (error) {
        failures.push({
          title: item.title,
          url: item.url,
          error: error.message || String(error)
        });
      }
    }

    if (!results.length && failures.length) {
      await notifySource(`Export failed for all ${failures.length} selected conversations.`, true);
      return;
    }

    const zipBlob = await buildExportZip(results, failures, formats);
    await downloadBlob(zipBlob, `gemini-export-${timestampForFile()}.zip`);

    const suffix = failures.length ? ` ${failures.length} failed.` : "";
    const cancelled = state.cancelled ? " Cancelled after current item." : "";
    await notifySource(`Export complete: ${results.length} conversations saved as ${formats.join(", ")}.${suffix}${cancelled}`, true);
  } catch (error) {
    await notifySource(`Export failed: ${error.message || String(error)}`, true);
  } finally {
    await closeWorkerTab();
    state.running = false;
    state.cancelled = false;
  }
}

async function notifySource(message, done = false) {
  await setProgress({ message, done, updatedAt: new Date().toISOString() });
  if (!state.sourceTabId) return;
  try {
    await chrome.tabs.sendMessage(state.sourceTabId, {
      type: "GBE_EXPORT_PROGRESS",
      message,
      done
    });
  } catch {
    // The source tab may have been closed. The export can still finish.
  }
}

async function setProgress(progress) {
  try {
    const storage = chrome.storage.session || chrome.storage.local;
    await storage.set({ gbeProgress: progress });
    if (progress.done) {
      await storage.remove("gbeProgress");
    }
  } catch {
    // Progress storage is best-effort and never stores conversation content.
  }
}

async function extractFromWorkerTab(item) {
  const tabId = await ensureWorkerTab(item.url);
  await waitForTabComplete(tabId);
  await delay(800);
  const response = await sendMessageWithRetry(tabId, {
    type: "GBE_EXTRACT_CONVERSATION",
    fallbackTitle: item.title
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Conversation extraction failed.");
  }
  return response.conversation;
}

async function ensureWorkerTab(url) {
  if (state.workerTabId) {
    try {
      await chrome.tabs.update(state.workerTabId, { url, active: false });
      return state.workerTabId;
    } catch {
      state.workerTabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url, active: false });
  state.workerTabId = tab.id;
  return tab.id;
}

async function closeWorkerTab() {
  if (!state.workerTabId) return;
  try {
    await chrome.tabs.remove(state.workerTabId);
  } catch {
    // The user or browser may already have closed it.
  } finally {
    state.workerTabId = null;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await delay(250);
  }
  throw new Error("Timed out while loading the conversation tab.");
}

async function sendMessageWithRetry(tabId, message, attempts = 20) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError || new Error("Content script did not respond.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(value, fallback = "conversation") {
  const cleaned = (value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toMarkdown(conversation) {
  const lines = [
    `# ${conversation.title}`,
    "",
    `Source: ${conversation.url}`,
    `Exported: ${conversation.exportedAt}`,
    ""
  ];

  for (const message of conversation.messages) {
    lines.push(`## ${message.role === "user" ? "User" : "Gemini"} ${message.index + 1}`);
    lines.push("");
    lines.push(message.content || "");
    lines.push("");
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

async function buildExportZip(conversations, failures, formats) {
  const files = {};
  const usedNames = new Map();
  const selected = new Set(formats.length ? formats : ["md"]);

  for (const conversation of conversations) {
    const base = uniqueName(sanitizeFileName(conversation.title), usedNames);
    if (selected.has("md")) files[`${base}.md`] = toMarkdown(conversation);
    if (selected.has("pdf")) files[`${base}.pdf`] = toPdfBytes(conversation);
    if (selected.has("docx")) files[`${base}.docx`] = await blobToBytes(createDocx(conversation));
    if (selected.has("xlsx")) files[`${base}.xlsx`] = await blobToBytes(createXlsx(conversation));
  }

  if (failures.length) {
    files["_failures.txt"] = failures
      .map((failure, index) => [
        `#${index + 1}`,
        `Title: ${failure.title}`,
        `URL: ${failure.url}`,
        `Error: ${failure.error}`
      ].join("\n"))
      .join("\n\n");
  }

  return createZip(files);
}

function uniqueName(name, usedNames) {
  const count = usedNames.get(name) || 0;
  usedNames.set(name, count + 1);
  return count === 0 ? name : `${name} (${count + 1})`;
}

async function downloadBlob(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
  });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function normalizeFileContent(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return textBytes(String(content));
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createDocx(conversation) {
  const paragraphs = [
    conversation.title,
    `Source: ${conversation.url}`,
    `Exported: ${conversation.exportedAt}`,
    ""
  ];
  for (const message of conversation.messages) {
    paragraphs.push(`${message.role === "user" ? "User" : "Gemini"} ${message.index + 1}`);
    paragraphs.push(message.content || "");
    paragraphs.push("");
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(paragraph)}</w:t></w:r></w:p>`).join("")}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  return createZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/document.xml": documentXml
  }, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

function createXlsx(conversation) {
  const rows = [
    ["Conversation Title", "URL", "Exported At", "Message #", "Role", "Content"],
    ...conversation.messages.map((message) => [
      conversation.title,
      conversation.url,
      conversation.exportedAt,
      String(message.index + 1),
      message.role === "user" ? "User" : "Gemini",
      message.content || ""
    ])
  ];
  const sheetData = rows.map((row, rowIndex) => {
    const cells = row.map((cell, cellIndex) => {
      const ref = `${columnName(cellIndex + 1)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");

  return createZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Conversation" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetData}</sheetData>
</worksheet>`
  }, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const mod = (index - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    index = Math.floor((index - mod) / 26);
  }
  return name;
}

function toPdfBytes(conversation) {
  const lines = toMarkdown(conversation)
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?")
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, 92));
  const pages = [];
  for (let i = 0; i < lines.length; i += 45) {
    pages.push(lines.slice(i, i + 45));
  }
  if (!pages.length) pages.push([""]);

  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectIds = pages.map((_, index) => 3 + index * 2);
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  pages.forEach((pageLines, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const stream = [
      "BT",
      "/F1 10 Tf",
      "12 TL",
      "50 790 Td",
      ...pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`),
      "ET"
    ].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  const body = ["%PDF-1.4\n"];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.join("").length);
    body.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = body.join("").length;
  body.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i += 1) {
    body.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  body.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return textBytes(body.join(""));
}

function wrapLine(line, width) {
  if (!line) return [""];
  const chunks = [];
  for (let i = 0; i < line.length; i += width) {
    chunks.push(line.slice(i, i + width));
  }
  return chunks;
}

function pdfEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function createZip(files, mimeType = "application/zip") {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = normalizeFileContent(content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, centralParts.length, true);
  endView.setUint16(10, centralParts.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: mimeType });
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
