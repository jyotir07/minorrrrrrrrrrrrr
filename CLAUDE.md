# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — bundle `renderer.js` (and its imports under `src/`) into `dist/bundle.js` via webpack. **Must be run before `npm start` and after any change to renderer-side code**, since `index.html` loads `./dist/bundle.js` directly (there is no watch/dev-server script wired up despite `webpack-dev-server` being in devDependencies).
- `npm start` — launch the Electron app (`electron .`).
- `npm run package` — produce a distributable via electron-builder (output in `release/`, appId `com.minor2.editor`).
- No test suite is configured; the `test` script is a stub that exits 1.

## Architecture

This is an Electron desktop code editor built around Monaco Editor. The codebase splits across the standard Electron three-process boundary, with a non-obvious build step in the middle:

- **Main process — `main.js`** (ES module; `package.json` has `"type": "module"`). Owns the `BrowserWindow`, the application menu (File ▸ Open / Save with `Ctrl+O` / `Ctrl+S`), and all `fs` access for opening/saving via `dialog`. It communicates with the renderer through two IPC channels: it `send`s `file-opened` (with file contents) and `save-file` (a request), and listens for `file-content` from the renderer to write the save dialog's chosen path.

- **Preload — `preload.js`** (CommonJS — uses `require`, despite the package being `"type": "module"`; this is intentional because Electron's preload context is CJS). Exposes a single `window.api` object via `contextBridge`. This is the **only** surface the renderer has into Node — `contextIsolation: true` and `nodeIntegration: false` are set in `main.js`. `window.api` wraps the IPC events plus thin pass-throughs to `fs/promises` (`readDir`, `readFile`) and `path.join` so the renderer can populate the file explorer without re-enabling Node integration.

- **Renderer — `renderer.js` + `src/editor.js`** (ES modules, bundled by webpack). `renderer.js` is the webpack entry point; `index.html` loads only the resulting `dist/bundle.js`. `src/editor.js` wraps Monaco's `editor.create` (theme `vs-dark`, language `javascript`, `automaticLayout: true`). The renderer wires `window.api.onFileOpened` → `editor.setValue` and `window.api.onSaveFile` → `editor.getValue()` → `window.api.sendContent`, and renders a flat (non-recursive) file explorer of the cwd using `readDir`/`joinPath`. Note that monaco-editor is bundled directly — there is no separate worker config, so language services run on the main renderer thread.

### Save flow (multi-file to understand)

`Ctrl+S` does **not** save in place. Menu click in `main.js` → `webContents.send("save-file")` → preload's `onSaveFile` → renderer reads editor value and calls `sendContent` → main's `ipcMain.on("file-content")` opens a **new** save dialog every time (default name `my-file.js`). The originally opened file path is not tracked anywhere, so "Save" always behaves like "Save As".

### Build-config note

Both `webpack.config.cjs` and `webpack.config.js` exist with nearly identical content. Only `.cjs` is referenced by the `build` script; `.js` is vestigial. When editing webpack config, edit the `.cjs` file.

### README vs. reality

The README advertises chokidar-based file watching and a "live-sync collaborative" feature; chokidar is a declared dependency but is **not yet wired up** in any source file. Treat the README as aspirational for those features.
