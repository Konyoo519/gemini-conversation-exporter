# Gemini Batch Exporter

Chrome Manifest V3 extension for locally batch exporting selected Gemini conversations to Markdown, Word, Excel, or PDF.

## What it does

- Adds checkboxes to the loaded Gemini conversation history list.
- Lets you select loaded conversations, clear selection, and start a batch export.
- Reuses one temporary inactive tab during export, extracts the visible user/Gemini messages, then closes the tab.
- After clicking **Export**, lets you choose any combination of `.md`, `.docx`, `.xlsx`, and `.pdf`.
- Downloads a ZIP containing the selected file formats for each successful conversation.
- Stores and processes content only in the browser. No server is used.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `gemini-batch-exporter`.
5. Open `https://gemini.google.com`.

## Use

1. Make sure Gemini's left history list is visible.
2. If you want more conversations available, scroll the history list first.
3. Tick individual conversations or click **Select loaded**.
4. Click **Export**.
5. Choose one or more formats: Excel, Word, PDF, or MD.
6. Click **Start** and choose where to save the generated ZIP.

## Limitations

- The first version exports only conversations currently loaded in Gemini's history list.
- It does not auto-scroll the entire history or provide date/keyword filters.
- Gemini's page structure can change. If extraction fails, update the selectors in `content.js`.
- Very large exports use a `data:` download URL, which is fine for normal personal batches but may be unsuitable for extremely large archives.
- Chrome extensions cannot read another Gemini conversation's DOM without loading that conversation somewhere. This extension keeps that to one temporary inactive tab instead of opening one tab per conversation.
- PDF export is a basic text PDF. Markdown, Word, and Excel preserve non-English text more reliably.

## Files

- `manifest.json`: extension permissions and content script configuration.
- `content.js`: Gemini page UI injection and conversation extraction.
- `background.js`: batch orchestration, ZIP generation, and download.
- `styles.css`: injected extension UI styles..


