const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

let bridgeProcess = null;

function startWhatsappBridge() {
  if (bridgeProcess) {
    return;
  }

  const bridgeDir = path.join(__dirname, 'whatsapp-webjs-bridge');
  const bridgeEntry = path.join(bridgeDir, 'dist', 'server.js');

  bridgeProcess = spawn(process.execPath, [bridgeEntry], {
    cwd: bridgeDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: process.env.PORT || '3344',
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*'
    },
    stdio: 'inherit',
    windowsHide: true
  });

  bridgeProcess.on('exit', (code) => {
    console.log(`[electron] whatsapp-webjs bridge finalizada (code=${code ?? 'null'})`);
    bridgeProcess = null;
  });

  bridgeProcess.on('error', (error) => {
    console.error('[electron] falha ao iniciar whatsapp-webjs bridge:', error);
    bridgeProcess = null;
  });
}

function stopWhatsappBridge() {
  if (!bridgeProcess || bridgeProcess.killed) {
    return;
  }

  bridgeProcess.kill();
  bridgeProcess = null;
}

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

  const rendererIndex = resolveRendererIndexPath();
  if (!rendererIndex) {
    throw new Error('Nao foi possivel localizar dist/uniq-system/index.html para iniciar o renderer.');
  }

  win.loadURL(pathToFileURL(rendererIndex).toString());
  Menu.setApplicationMenu(null);
}

function resolveRendererIndexPath() {
  const candidates = [
    path.join(process.cwd(), 'dist', 'uniq-system', 'index.html'),
    path.join(__dirname, 'dist', 'uniq-system', 'index.html'),
    path.join(app.getAppPath(), 'dist', 'uniq-system', 'index.html')
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || null;
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

app.whenReady().then(() => {
  startWhatsappBridge();
  createWindow();
});

app.on('before-quit', () => {
  stopWhatsappBridge();
});
