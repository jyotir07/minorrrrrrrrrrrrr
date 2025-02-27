import * as monaco from 'monaco-editor';

export function createEditor(container) {
  monaco.editor.create(container, {
    value: "// Start coding here...",
    language: "javascript",
    theme: "vs-dark",
    automaticLayout: true,
  });
}
