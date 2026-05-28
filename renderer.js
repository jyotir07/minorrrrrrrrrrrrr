  import { createEditor } from "./src/editor.js";

  window.addEventListener("DOMContentLoaded", async () => {
    const editor = createEditor(document.getElementById("editor"));
    const fileExplorer = document.getElementById("file-explorer");

    window.api.onFileOpened((data) => {
      editor.setValue(data);
    });

    window.api.onSaveFile(() => {
      const content = editor.getValue();
      window.api.sendContent(content);
    });

    const openFile = async (filePath) => {
      try {
        const content = await window.api.readFile(filePath);
        editor.setValue(content);
      } catch (err) {
        console.error("Failed to read file:", err);
      }
    };

    const renderFileExplorer = async (dirPath) => {
      try {
        const entries = await window.api.readDir(dirPath);
        fileExplorer.innerHTML = ""; // Clear existing entries
        for (const entry of entries) {
          const entryPath = await window.api.joinPath(dirPath, entry.name);
          const entryEl = document.createElement("div");
          entryEl.textContent = entry.name;
          if (entry.isFile()) {
            entryEl.style.cursor = "pointer";
            entryEl.addEventListener("click", () => openFile(entryPath));
          } else if (entry.isDirectory()) {
            entryEl.style.fontWeight = "bold";
            // Could add logic to open directories here
          }
          fileExplorer.appendChild(entryEl);
        }
      } catch (err) {
        console.error("Failed to read directory:", err);
      }
    };

    renderFileExplorer(".");
  });
  