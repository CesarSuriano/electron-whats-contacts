const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    icon: __dirname + '/src/assets/logo-fundo-vermelho.ico',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.maximize();

  win.loadURL(`file://${path.join(__dirname, 'dist/uniq-system/index.html')}`);
  Menu.setApplicationMenu(null);
}

// Handler para carregar o XML a partir da pasta do executável (produção)
// ou da pasta atual (desenvolvimento). O arquivo pode ter qualquer nome,
// desde que tenha extensão .xml.
ipcMain.handle('load-xml', async () => {
  const baseDir = app.isPackaged ? path.dirname(process.execPath) : process.cwd();

  const files = await fs.promises.readdir(baseDir);
  const xmlFiles = files.filter((f) => f.toLowerCase().endsWith('.xml'));

  if (!xmlFiles.length) {
    throw new Error(`Nenhum arquivo XML encontrado em ${baseDir}`);
  }

  // Se houver mais de um, pega o primeiro em ordem alfabética
  xmlFiles.sort();
  const xmlPath = path.join(baseDir, xmlFiles[0]);

  return fs.promises.readFile(xmlPath, 'utf8');
});

app.whenReady().then(createWindow);
