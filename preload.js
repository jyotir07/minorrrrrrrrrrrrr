const { contextBridge } = require("electron");
const monaco = require("monaco-editor");

contextBridge.exposeInMainWorld("api", {
  showAlert: (msg) => alert(msg),
  Monaco: monaco, 
});
