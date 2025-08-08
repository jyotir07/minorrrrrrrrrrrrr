import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile("index.html");

  const menuTemplate = [
    {
      label: "File",
      submenu: [
        {
          label: "Open File",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            dialog
              .showOpenDialog({
                properties: ["openFile"],
              })
              .then((result) => {
                if (!result.canceled) {
                  const filePath = result.filePaths[0];
                  fs.readFile(filePath, "utf-8", (err, data) => {
                    if (err) {
                      console.log(err);
                      return;
                    }
                    win.webContents.send("file-opened", data);
                  });
                }
              })
              .catch((err) => {
                console.log(err);
              });
          },
        },
        {
          label: "Save File",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            win.webContents.send("save-file");
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  ipcMain.on("file-content", (event, content) => {
    dialog
      .showSaveDialog({
        title: "Save File",
        defaultPath: "my-file.js",
      })
      .then((result) => {
        if (!result.canceled) {
          fs.writeFile(result.filePath, content, (err) => {
            if (err) {
              console.log(err);
            }
          });
        }
      })
      .catch((err) => {
        console.log(err);
      });
  });
});
