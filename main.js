const { app, BrowserWindow, Menu, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

// Em desenvolvimento, usa pasta userData separada para não vazar dados com o release
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'uniq-system-dev'));
}

// ─── Telemetria ─────────────────────────────────────────────────────────────
// Eventos do processo principal (início do app, quedas da bridge, tela
// travada) vão para um arquivo local; a bridge lê esse arquivo e envia ao
// Firestore junto com os dela. Assim eles sobrevivem até a uma queda da bridge.
// A configuração web do Firebase não é secreta: as regras do Firestore só
// permitem criar registros.
const TELEMETRY_FIREBASE = {
  apiKey: 'AIzaSyBWJKYlE22t9wrRLhrJWWzvRNIWCc94G2c',
  projectId: 'uniq-system'
};
const TELEMETRY_MAIN_QUEUE_MAX_BYTES = 1024 * 1024;
const telemetryEnabled = process.env.UNIQ_TELEMETRY_DISABLED !== '1';
const telemetrySessionId = crypto.randomUUID();
const appStartedAt = Date.now();
let telemetryInstallId = '';

function getTelemetryDir() {
  return path.join(app.getPath('userData'), 'telemetry');
}

function getTelemetryInstallId() {
  if (telemetryInstallId) {
    return telemetryInstallId;
  }

  const dir = getTelemetryDir();
  const file = path.join(dir, 'install.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.installId === 'string' && saved.installId) {
      telemetryInstallId = saved.installId;
      return telemetryInstallId;
    }
  } catch {
    // Primeira execução: cria abaixo.
  }

  telemetryInstallId = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ installId: telemetryInstallId, createdAt: new Date().toISOString() }));
  } catch {
    // Sem disco o ID vale só nesta execução.
  }
  return telemetryInstallId;
}

function trackMain(name, data = {}) {
  if (!telemetryEnabled) {
    return;
  }

  try {
    const dir = getTelemetryDir();
    const file = path.join(dir, 'pending-main.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > TELEMETRY_MAIN_QUEUE_MAX_BYTES) {
      return;
    }
    fs.appendFileSync(file, `${JSON.stringify({ name, ts: new Date().toISOString(), sid: telemetrySessionId, data })}\n`);
  } catch {
    // Telemetria nunca pode atrapalhar o app.
  }
}

function buildTelemetryEnv() {
  if (!telemetryEnabled) {
    return { TELEMETRY_DISABLED: '1' };
  }

  return {
    TELEMETRY_FIREBASE_API_KEY: TELEMETRY_FIREBASE.apiKey,
    TELEMETRY_FIREBASE_PROJECT_ID: TELEMETRY_FIREBASE.projectId,
    TELEMETRY_INSTALL_ID: getTelemetryInstallId(),
    TELEMETRY_SESSION_ID: telemetrySessionId,
    TELEMETRY_APP_VERSION: app.getVersion(),
    TELEMETRY_ENV: app.isPackaged ? 'production' : 'development',
    TELEMETRY_DIR: getTelemetryDir(),
    TELEMETRY_BRIDGE_RESTART: String(bridgeRestartCount)
  };
}

// Observa exceções do processo principal sem mudar o comportamento padrão.
process.on('uncaughtExceptionMonitor', (error) => {
  trackMain('error.main_uncaught', { message: error && error.message ? error.message : String(error) });
});

let bridgeProcess = null;
let bridgeRestartCount = 0;
let bridgeStableTimer = null;
const BRIDGE_MAX_RESTARTS = 5;
const BRIDGE_RESTART_DELAY_MS = 2000;
const BRIDGE_STABLE_AFTER_MS = 60_000;
let agentWindow = null;
let agentWindowPartition = '';
let isAppQuitting = false;

const AGENT_PARTITION_PREFIX = 'persist:uniq-system.agent.';
const AGENT_WINDOW_TITLE = 'Agente Uniq';
const AGENT_COMPOSER_WAIT_MS = 30_000;
const AGENT_RESPONSE_WAIT_MS = 70_000;
const AGENT_POLL_INTERVAL_MS = 900;
const AGENT_IGNORED_RESPONSE_PATTERNS = [
  /^o gemini e uma ia e pode cometer erros\.?$/i,
  /^gemini can make mistakes.*$/i,
  /^double check it\.?$/i,
  /^confira as respostas\.?$/i,
  /^share gem\.?$/i,
  /^compartilhar gem\.?$/i
];

function findSystemChromium() {
  const env = process.env;
  const pf = env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = env['LOCALAPPDATA'] || '';

  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];

  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function buildAgentPartition(googleAccountId) {
  const normalizedId = String(googleAccountId || 'primary')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `${AGENT_PARTITION_PREFIX}${normalizedId || 'primary'}`;
}

function getAgentResponseModeLabels(responseMode) {
  if (responseMode === 'reasoning') {
    return ['raciocinio', 'raciocínio', 'reasoning', 'thinking'];
  }

  if (responseMode === 'pro') {
    return [' pro ', ' pro', 'pro ', 'modo pro', 'gemini pro'];
  }

  return ['respostas rápidas', 'respostas rapidas', 'quick responses', 'fast'];
}

const AGENT_DOM_HELPERS = `
  const uniqNormalizeText = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const uniqIsVisible = (element) => {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const uniqLabelFor = (element) => uniqNormalizeText(
    element?.getAttribute?.('aria-label')
    || element?.getAttribute?.('data-tooltip')
    || element?.getAttribute?.('title')
    || element?.innerText
    || element?.textContent
    || ''
  );
  const uniqFindVisibleButton = (pattern) => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    return buttons.find((button) => uniqIsVisible(button) && pattern.test(uniqLabelFor(button)) && !button.disabled) || null;
  };
  const uniqFindComposer = () => {
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label]',
      'rich-textarea div[contenteditable="true"]',
      'textarea[aria-label]',
      'textarea'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      const match = candidates.find((candidate) => uniqIsVisible(candidate) && !candidate.closest('[aria-hidden="true"]'));
      if (match) {
        return match;
      }
    }

    return null;
  };
  const uniqReadBlocks = () => {
    const root = document.querySelector('main') || document.body;
    const selectors = 'message-content, [data-message-author-role], [data-message-id], .markdown, article, p, li, div';
    const elements = Array.from(root.querySelectorAll(selectors));
    const seen = new Set();
    const blocks = [];

    for (const element of elements) {
      if (!uniqIsVisible(element) || element.closest('button, nav, header, footer, form')) {
        continue;
      }

      const text = uniqNormalizeText(element.innerText || element.textContent);
      if (text.length < 20 || text.length > 5000) {
        continue;
      }

      const hasEquivalentChild = Array.from(element.children || []).some((child) => uniqNormalizeText(child.innerText || child.textContent) === text);
      if (hasEquivalentChild) {
        continue;
      }

      if (/^(gemini|gems|share|compartilhar|settings|configuracoes|novo chat)$/i.test(text)) {
        continue;
      }

      if (!seen.has(text)) {
        seen.add(text);
        blocks.push(text);
      }
    }

    return blocks.slice(-80);
  };
`;

function startWhatsappBridge() {
  if (bridgeProcess) {
    return;
  }

  // Em produção, a bridge fica em app.asar.unpacked para ter acesso completo ao
  // sistema de arquivos (necessário para o Puppeteer/whatsapp-web.js gravar
  // perfil do Chrome, sockets, etc.). Em desenvolvimento usa __dirname direto.
  const bridgeBase = app.isPackaged
    ? __dirname.replace('app.asar', 'app.asar.unpacked')
    : __dirname;

  const bridgeDir = path.join(bridgeBase, 'whatsapp-webjs-bridge');
  const bridgeEntry = path.join(bridgeDir, 'dist', 'server.js');

  const systemBrowser = findSystemChromium();
  if (!systemBrowser) {
    const msg = 'Nao foi possivel localizar Microsoft Edge nem Google Chrome no sistema. '
      + 'Instale o Edge (padrao no Windows 10/11) ou o Chrome e tente novamente.\n';
    console.error(`[electron] ${msg}`);
    trackMain('bridge.no_browser', {});
    return;
  }

  const bridgeStartedAt = Date.now();
  trackMain('bridge.spawn', {
    restart: bridgeRestartCount,
    browser: path.basename(systemBrowser),
    msSinceAppStart: bridgeStartedAt - appStartedAt
  });

  bridgeProcess = spawn(process.execPath, [bridgeEntry], {
    cwd: bridgeDir,
    env: {
      ...process.env,
      ...buildTelemetryEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      PORT: process.env.PORT || '3344',
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
      WWEBJS_DATA_PATH: app.getPath('userData'),
      PUPPETEER_EXECUTABLE_PATH: systemBrowser,
      // Apenas as flags mínimas necessárias. NAO incluir --disable-gpu nem
      // --no-zygote: ambas impedem o whatsapp-web.js de injetar a Store
      // após a autenticação, deixando o cliente eternamente em "authenticated".
      PUPPETEER_ARGS: '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--no-first-run,--window-position=-2400,-2400'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  bridgeProcess.stdout.on('data', (data) => {
    const text = String(data);
    process.stdout.write(text);
  });

  bridgeProcess.stderr.on('data', (data) => {
    const text = String(data);
    process.stderr.write(text);
  });

  if (bridgeStableTimer) {
    clearTimeout(bridgeStableTimer);
  }
  bridgeStableTimer = setTimeout(() => {
    bridgeRestartCount = 0;
  }, BRIDGE_STABLE_AFTER_MS);

  bridgeProcess.on('exit', (code, signal) => {
    const msg = `whatsapp-webjs bridge finalizada (code=${code ?? 'null'})\n`;
    console.log(`[electron] ${msg}`);
    trackMain('bridge.exit', {
      code: code ?? null,
      signal: signal || null,
      uptimeMs: Date.now() - bridgeStartedAt,
      quitting: isAppQuitting
    });
    bridgeProcess = null;

    if (bridgeStableTimer) {
      clearTimeout(bridgeStableTimer);
      bridgeStableTimer = null;
    }

    if (isAppQuitting || code === 0) {
      return;
    }

    if (bridgeRestartCount >= BRIDGE_MAX_RESTARTS) {
      console.error('[electron] bridge caiu repetidamente; nao sera reiniciada automaticamente.');
      trackMain('bridge.gave_up', { restarts: bridgeRestartCount });
      return;
    }

    bridgeRestartCount += 1;
    trackMain('bridge.restart_scheduled', { attempt: bridgeRestartCount, lastExitCode: code ?? null });
    console.log(`[electron] reiniciando bridge em ${BRIDGE_RESTART_DELAY_MS}ms (tentativa ${bridgeRestartCount}/${BRIDGE_MAX_RESTARTS})...`);
    setTimeout(() => {
      if (!isAppQuitting) {
        startWhatsappBridge();
      }
    }, BRIDGE_RESTART_DELAY_MS);
  });

  bridgeProcess.on('error', (error) => {
    const msg = `falha ao iniciar bridge: ${error.message}\n`;
    console.error(`[electron] ${msg}`);
    trackMain('bridge.spawn_error', { message: error.message });
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeAgentComparisonText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isAgentPromptEcho(candidate, normalizedPrompt) {
  if (!candidate || !normalizedPrompt) {
    return false;
  }

  if (candidate === normalizedPrompt) {
    return true;
  }

  return candidate.length > 80 && normalizedPrompt.includes(candidate);
}

function cleanAgentResponseText(value) {
  return String(value || '')
    .replace(/O Gemini é uma IA e pode cometer erros\.?/gi, '')
    .replace(/Gemini can make mistakes, so double-check it\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAgentIgnoredBlock(value) {
  const normalized = normalizeAgentComparisonText(value);

  if (!normalized) {
    return true;
  }

  if ((normalized.includes('gemini') || normalized.includes('ia')) && (normalized.includes('erros') || normalized.includes('mistakes'))) {
    return true;
  }

  return AGENT_IGNORED_RESPONSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function createAgentWindow(showWindow, googleAccountId) {
  const partition = buildAgentPartition(googleAccountId);

  if (agentWindow && !agentWindow.isDestroyed() && agentWindowPartition !== partition) {
    agentWindow.destroy();
    agentWindow = null;
    agentWindowPartition = '';
  }

  if (agentWindow && !agentWindow.isDestroyed()) {
    if (showWindow) {
      agentWindow.show();
      agentWindow.focus();
    }
    return agentWindow;
  }

  agentWindowPartition = partition;

  agentWindow = new BrowserWindow({
    width: 1380,
    height: 940,
    minWidth: 1024,
    minHeight: 720,
    show: showWindow,
    autoHideMenuBar: true,
    title: AGENT_WINDOW_TITLE,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  agentWindow.on('closed', () => {
    agentWindow = null;
    agentWindowPartition = '';
  });

  return agentWindow;
}

async function ensureAgentWindow({ gemUrl, keepVisible, forceReload = false, googleAccountId }) {
  if (!gemUrl || typeof gemUrl !== 'string') {
    throw new Error('Informe o link do agente antes de continuar.');
  }

  const targetUrl = gemUrl.trim();
  const win = createAgentWindow(Boolean(keepVisible), googleAccountId);
  const currentUrl = win.webContents.getURL();

  if (forceReload || !currentUrl || currentUrl !== targetUrl) {
    await win.loadURL(targetUrl);
  }

  if (keepVisible) {
    win.show();
    win.focus();
  } else if (win.isVisible()) {
    win.hide();
  }

  await delay(1200);
  return win;
}

async function inspectAgentComposer(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      const composer = uniqFindComposer();
      const bodyText = uniqNormalizeText((document.body.innerText || '').slice(0, 5000));
      const loginRequired = /accounts.google.com/i.test(location.href)
        || (!composer && /(fazer login|sign in|entrar)/i.test(bodyText));

      return {
        ready: Boolean(composer),
        loginRequired,
        currentUrl: location.href,
        label: composer ? uniqLabelFor(composer) : '',
        generating: Boolean(uniqFindVisibleButton(/(stop|parar)/i))
      };
    })();
  `);
}

async function readAgentGoogleAccountLabel(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
      const bodyText = uniqNormalizeText((document.body.innerText || '').slice(0, 12000));
      const bodyMatch = bodyText.match(emailPattern);

      if (bodyMatch?.length) {
        return bodyMatch[0];
      }

      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, img[alt], [aria-label], [title]'))
        .filter((element) => uniqIsVisible(element))
        .map((element) => uniqLabelFor(element))
        .filter(Boolean);

      for (const candidate of candidates) {
        const emailMatch = candidate.match(emailPattern);
        if (emailMatch?.length) {
          return emailMatch[0];
        }
      }

      const accountCandidate = candidates.find((candidate) => /(google account|conta google|my account|gerenciar sua conta)/i.test(candidate));
      return accountCandidate || '';
    })();
  `);
}

async function readAgentTextBlocks(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      return uniqReadBlocks();
    })();
  `);
}

async function focusAgentComposer(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      const composer = uniqFindComposer();
      if (!composer) {
        return { ok: false, message: 'composer-not-found' };
      }

      composer.focus();

      if ('value' in composer) {
        composer.value = '';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        composer.textContent = '';
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'deleteContentBackward',
          data: null
        }));
      }

      return { ok: true, label: uniqLabelFor(composer) };
    })();
  `);
}

async function selectAgentResponseMode(win, responseMode) {
  const labels = getAgentResponseModeLabels(responseMode).map((label) => label.toLowerCase());

  if (!labels.length) {
    return { ok: false, skipped: true };
  }

  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      const labels = ${JSON.stringify(labels)};
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const match = buttons.find((button) => {
        if (!uniqIsVisible(button) || button.disabled) {
          return false;
        }

        const label = ' ' + uniqLabelFor(button).toLowerCase() + ' ';
        return labels.some((candidate) => label.includes(candidate));
      });

      if (!match) {
        return { ok: false, label: '' };
      }

      match.click();
      return { ok: true, label: uniqLabelFor(match) };
    })();
  `);
}

async function clickAgentSendButton(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      const button = uniqFindVisibleButton(/(send|enviar|submit|mandar)/i);
      if (!button) {
        return { ok: false, label: '' };
      }

      button.click();
      return { ok: true, label: uniqLabelFor(button) };
    })();
  `);
}

async function inspectAgentConversationState(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      ${AGENT_DOM_HELPERS}
      const bodyText = uniqNormalizeText((document.body.innerText || '').slice(0, 5000));

      return {
        blocks: uniqReadBlocks(),
        generating: Boolean(uniqFindVisibleButton(/(stop|parar)/i)),
        loginRequired: /accounts.google.com/i.test(location.href)
          || /(fazer login|sign in|entrar)/i.test(bodyText)
      };
    })();
  `);
}

async function waitForAgentComposer(win) {
  const deadline = Date.now() + AGENT_COMPOSER_WAIT_MS;

  while (Date.now() < deadline) {
    const state = await inspectAgentComposer(win);

    if (state.loginRequired) {
      win.show();
      win.focus();
      throw new Error('A janela do agente foi aberta, mas a conta Google ainda precisa estar logada. Faça login nela e tente novamente.');
    }

    if (state.ready) {
      return state;
    }

    await delay(AGENT_POLL_INTERVAL_MS);
  }

  win.show();
  win.focus();
  throw new Error('Não encontrei o campo de mensagem do agente. Deixe a janela terminar de carregar e tente novamente.');
}

async function waitForAgentResponse(win, beforeBlocks, prompt) {
  const deadline = Date.now() + AGENT_RESPONSE_WAIT_MS;
  const beforeSet = new Set(beforeBlocks.map((block) => normalizeAgentComparisonText(cleanAgentResponseText(block))).filter(Boolean));
  const normalizedPrompt = normalizeAgentComparisonText(prompt);
  let lastCandidate = '';
  let lastIgnoredCandidate = '';
  let stableCount = 0;

  while (Date.now() < deadline) {
    const state = await inspectAgentConversationState(win);

    if (state.loginRequired) {
      win.show();
      win.focus();
      throw new Error('O agente redirecionou para login. Faça a autenticação na janela aberta e tente novamente.');
    }

    const newBlocks = Array.isArray(state.blocks) ? state.blocks : [];
    let candidate = '';

    for (let index = newBlocks.length - 1; index >= 0; index -= 1) {
      const cleanedBlock = cleanAgentResponseText(newBlocks[index]);
      const normalizedBlock = normalizeAgentComparisonText(cleanedBlock);

      if (!normalizedBlock || beforeSet.has(normalizedBlock) || isAgentPromptEcho(normalizedBlock, normalizedPrompt)) {
        continue;
      }

      if (isAgentIgnoredBlock(cleanedBlock)) {
        lastIgnoredCandidate = cleanedBlock;
        continue;
      }

      candidate = cleanedBlock;
      break;
    }

    if (candidate) {
      if (candidate === lastCandidate) {
        stableCount += 1;
      } else {
        lastCandidate = candidate;
        stableCount = 1;
      }

      if (stableCount >= 2 && !state.generating) {
        return candidate;
      }
    }

    await delay(candidate ? 1200 : AGENT_POLL_INTERVAL_MS);
  }

  if (lastCandidate) {
    return lastCandidate;
  }

  if (lastIgnoredCandidate) {
    throw new Error('Só encontrei texto fixo do Gemini web, não a resposta do agente. Ajustei o filtro para ignorar esse aviso; tente novamente.');
  }

  throw new Error('O agente não devolveu uma resposta legível a tempo. Confira a janela aberta para ver se houve bloqueio de login ou mudança no layout.');
}

async function runAgentSuggestion({ gemUrl, googleAccountId, prompt, keepVisible, responseMode }) {
  const win = await ensureAgentWindow({ gemUrl, keepVisible, forceReload: true, googleAccountId });
  await waitForAgentComposer(win);

  await selectAgentResponseMode(win, responseMode);
  await delay(220);

  const beforeBlocks = await readAgentTextBlocks(win);
  const focusResult = await focusAgentComposer(win);
  if (!focusResult?.ok) {
    throw new Error('Não consegui focar o campo de mensagem do agente. Confira a janela aberta e tente novamente.');
  }

  win.webContents.insertText(prompt);
  await delay(320);

  const clickResult = await clickAgentSendButton(win);
  if (!clickResult?.ok) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  }

  const response = await waitForAgentResponse(win, beforeBlocks, prompt);

  if (!keepVisible && !win.isDestroyed() && win.isVisible()) {
    win.hide();
  }

  return response;
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

  // Tela travada ("não respondendo") e tempo até a interface carregar.
  let unresponsiveSince = 0;
  win.webContents.on('did-finish-load', () => {
    trackMain('app.window_loaded', { msSinceAppStart: Date.now() - appStartedAt });
  });
  win.on('unresponsive', () => {
    unresponsiveSince = Date.now();
    trackMain('renderer.unresponsive', { msSinceAppStart: unresponsiveSince - appStartedAt });
  });
  win.on('responsive', () => {
    if (unresponsiveSince) {
      trackMain('renderer.responsive', { frozenMs: Date.now() - unresponsiveSince });
      unresponsiveSince = 0;
    }
  });

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

// ─── Auto-update helpers ────────────────────────────────────────────────────

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) { return diff; }
  }
  return 0;
}

function fetchJson(url) {
  return net.fetch(url).then(response => {
    if (!response.ok) {
      throw new Error(`Erro HTTP ${response.status} ao buscar versão`);
    }
    return response.json();
  });
}

function downloadWithNet(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const cleanup = () => { try { fs.unlinkSync(destPath); } catch {} };
    const request = net.request({ url, redirect: 'follow' });
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        file.close();
        cleanup();
        reject(new Error(`Download falhou: status ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => file.write(chunk));
      response.on('end', () => file.close(resolve));
      response.on('error', (err) => { file.close(); cleanup(); reject(err); });
    });
    request.on('error', (err) => { file.close(); cleanup(); reject(err); });
    request.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

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

ipcMain.handle('agent:open-window', async (_event, payload) => {
  try {
    const win = await ensureAgentWindow({
      gemUrl: payload?.gemUrl || '',
      googleAccountId: payload?.googleAccountId || 'primary',
      keepVisible: payload?.keepVisible !== false,
      forceReload: false
    });
    const detectedAccountLabel = await readAgentGoogleAccountLabel(win).catch(() => '');

    return {
      ok: true,
      message: 'Janela do agente aberta. Se esta conta já estiver autenticada, o app vai reaproveitar essa sessão nas próximas sugestões.',
      detectedAccountLabel
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Não foi possível abrir a janela do agente.'
    };
  }
});

ipcMain.handle('agent:generate-suggestion', async (_event, payload) => {
  const generatedAt = new Date().toISOString();

  try {
    const text = await runAgentSuggestion({
      gemUrl: payload?.gemUrl || '',
      googleAccountId: payload?.googleAccountId || 'primary',
      prompt: payload?.prompt || '',
      keepVisible: payload?.keepVisible !== false,
      responseMode: payload?.responseMode || 'fast'
    });

    return {
      ok: true,
      text,
      message: '',
      generatedAt
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      message: error instanceof Error ? error.message : 'Falha ao gerar a sugestão pelo agente.',
      generatedAt
    };
  }
});

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:check-update', async (_event, updateUrl) => {
  if (!updateUrl || typeof updateUrl !== 'string') {
    return { ok: false, error: 'URL de atualização não configurada.' };
  }
  try {
    const data = await fetchJson(updateUrl);
    const currentVersion = app.getVersion();
    const latestVersion = String(data.version || '');
    const isNewer = compareVersions(latestVersion, currentVersion) > 0;
    const downloadUrl = String(data.url || '');
    trackMain('update.checked', { currentVersion, latestVersion, isNewer, hasUrl: downloadUrl.length > 0 });
    return {
      ok: true,
      currentVersion,
      latestVersion,
      isNewer: isNewer && downloadUrl.length > 0,
      notes: String(data.notes || ''),
      downloadUrl
    };
  } catch (error) {
    trackMain('update.check_failed', { message: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : 'Erro ao verificar atualização.' };
  }
});

ipcMain.handle('app:install-update', async (_event, downloadUrl) => {
  if (!downloadUrl || typeof downloadUrl !== 'string') {
    return { ok: false, error: 'URL de download inválida.' };
  }
  try {
    let filename = 'UniqSystem-Setup.exe';
    try { filename = new URL(downloadUrl).pathname.split('/').filter(Boolean).pop() || filename; } catch {}
    const destPath = path.join(os.tmpdir(), filename);
    const downloadStartedAt = Date.now();
    trackMain('update.download_start', { filename });
    await downloadWithNet(downloadUrl, destPath);
    trackMain('update.download_done', { ms: Date.now() - downloadStartedAt });
    shell.openPath(destPath);
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (error) {
    trackMain('update.download_failed', { message: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : 'Erro ao baixar atualização.' };
  }
});

app.whenReady().then(() => {
  trackMain('app.start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    cpus: os.cpus().length
  });
  startWhatsappBridge();
  createWindow();
});

// Quedas de processos do Electron (janela, GPU etc.).
app.on('render-process-gone', (_event, _webContents, details) => {
  trackMain('renderer.gone', { reason: details && details.reason, exitCode: details && details.exitCode });
});

app.on('child-process-gone', (_event, details) => {
  trackMain('process.gone', { type: details && details.type, reason: details && details.reason, exitCode: details && details.exitCode });
});

app.on('before-quit', () => {
  if (!isAppQuitting) {
    trackMain('app.quit', { uptimeMin: Math.round((Date.now() - appStartedAt) / 60000) });
  }
  isAppQuitting = true;
  stopWhatsappBridge();

  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.destroy();
  }
});
