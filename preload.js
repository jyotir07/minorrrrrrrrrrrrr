const { contextBridge, ipcRenderer } = require("electron");
const fs = require("fs/promises");
const path = require("path");

contextBridge.exposeInMainWorld("api", {
  onFileOpened: (callback) => ipcRenderer.on("file-opened", (event, data) => callback(data)),
  onSaveFile: (callback) => ipcRenderer.on("save-file", callback),
  sendContent: (content) => ipcRenderer.send("file-content", content),
  readDir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
  readFile: (filePath) => fs.readFile(filePath, "utf-8"),
  joinPath: (...args) => path.join(...args),
});
