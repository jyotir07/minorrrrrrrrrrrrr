  import * as monaco from "monaco-editor";

  window.addEventListener("DOMContentLoaded", () => {
    monaco.editor.create(document.getElementById("editor"), {
      value: "Monacoisworking!",
      language: "javascript",
      theme: "vs-dark",
    });
  });
  