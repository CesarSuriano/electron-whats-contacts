import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import qrcodeTerminal from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import {
  normalizeJid,
  normalizePhone,
  normalizeRequestedChatJid,
  isSameConversationJid,
  isBlankMessage,
  readMessageTimestampSeconds,
  readMessageText,
  readMessageInlineImageDataUrl,
  toIsoFromUnixTimestamp
} from './lib/utils.js';
import { init as initJid, resolveIsFromMe, getSerializedMessageId, isSelfJid } from './lib/jid.js';
import { events, contactsByJid, ingestInboundMessage, pushEvent, updateEventAck, resetUnreadCount, setOnEventPushed } from './lib/events.js';
import {
  init as initHistory,
  acquireHistorySlot,
  releaseHistorySlot,
  loadRecentChatEvents,
  resolveChatsForHistory,
  fetchChatHistoryWithRecovery
} from './lib/history.js';
import {
  init as initContacts,
  refreshContactsFromChats,
  seedEventsFromRecentChats,
  fetchProfilePhotoUrl,
  getLastContactsRefreshAt,
  loadLabelsMap
} from './lib/contacts.js';
import {
  init as initSession,
  getInstanceSummary,
  getSessionSnapshot,
  ensureClientInitialized,
  disconnectClientSession
} from './lib/session.js';
import { createWebSocketServer, broadcast } from './lib/ws.js';

const { Client, LocalAuth, MessageMedia } = pkg;

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3344);
const allowedOriginRaw = process.env.ALLOWED_ORIGIN || 'http://localhost:4200';
const allowedOrigins = allowedOriginRaw
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const instanceName = process.env.INSTANCE_NAME || 'local-webjs';
const enableHistoryEvents = String(process.env.WA_ENABLE_HISTORY_EVENTS || 'true').toLowerCase() !== 'false';
const enableProfilePhotoFetch = String(process.env.WA_ENABLE_PROFILE_PHOTO_FETCH || 'true').toLowerCase() !== 'false';
const puppeteerExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const puppeteerArgs = String(process.env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const CONTACTS_REFRESH_COOLDOWN_MS = 25 * 1000;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === 'null') {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    if (origin.startsWith('file://') && allowedOrigins.includes('file://')) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  }
}));
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

const sessionState = {
  status: 'initializing',
  qr: null,
  lastError: ''
};

const client = new Client({
  authStrategy: new LocalAuth({ clientId: instanceName }),
  puppeteer: {
    executablePath: puppeteerExecutablePath,
    args: puppeteerArgs
  }
});

// Initialize modules
initJid(client);
initHistory(client, sessionState, { enableHistoryEvents });
initContacts(client, sessionState, { enableProfilePhotoFetch });
initSession(client, sessionState, instanceName);

client.on('qr', qr => {
  sessionState.status = 'qr_required';
  sessionState.qr = qr;
  sessionState.lastError = '';
  qrcodeTerminal.generate(qr, { small: true });
  console.log('[whatsapp-webjs-bridge] QR recebido. Escaneie no celular.');
  broadcast('session_state', getSessionSnapshot());
});

client.on('authenticated', () => {
  sessionState.status = 'authenticated';
  sessionState.qr = null;
  sessionState.lastError = '';
  console.log('[whatsapp-webjs-bridge] Sessao autenticada.');
  broadcast('session_state', getSessionSnapshot());
});

client.on('ready', async () => {
  sessionState.status = 'ready';
  sessionState.qr = null;
  sessionState.lastError = '';
  console.log('[whatsapp-webjs-bridge] Cliente pronto.');
  broadcast('session_state', getSessionSnapshot());

  try {
    const chats = await client.getChats();
    await refreshContactsFromChats(chats);
    await seedEventsFromRecentChats(chats);
    broadcast('contacts_updated', { contacts: Array.from(contactsByJid.values()) });
  } catch (error) {
    console.error('[whatsapp-webjs-bridge] Falha ao carregar contatos:', error.message);
  }
});

client.on('auth_failure', message => {
  sessionState.status = 'auth_failure';
  sessionState.lastError = String(message || 'Authentication failure');
  console.error('[whatsapp-webjs-bridge] Falha de autenticacao:', message);
  broadcast('session_state', getSessionSnapshot());
});

client.on('disconnected', reason => {
  sessionState.status = 'disconnected';
  sessionState.lastError = String(reason || 'Disconnected');
  console.warn('[whatsapp-webjs-bridge] Cliente desconectado:', reason);
  broadcast('session_state', getSessionSnapshot());
});

client.on('message', message => {
  console.log('[whatsapp-webjs-bridge] evento message:', {
    from: message?.from,
    to: message?.to,
    fromMe: resolveIsFromMe(message),
    type: message?.type
  });
  void ingestInboundMessage(message, 'webjs-inbound');
});

client.on('message_ack', (message, ack) => {
  const messageId = message?.id?._serialized || '';
  if (messageId) {
    updateEventAck(messageId, ack);
    broadcast('message_ack', { messageId, ack });
  }
});

client.on('message_create', message => {
  console.log('[whatsapp-webjs-bridge] evento message_create:', {
    from: message?.from,
    to: message?.to,
    fromMe: resolveIsFromMe(message),
    type: message?.type
  });
  // Some multi-device flows emit inbound only on message_create.
  if (!resolveIsFromMe(message)) {
    void ingestInboundMessage(message, 'webjs-inbound-create');
  }
});

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/whatsapp/session', (_, res) => {
  res.json(getSessionSnapshot());
});

app.post('/api/whatsapp/session/connect', async (_req, res) => {
  try {
    if (sessionState.status === 'ready' || sessionState.status === 'authenticated' || sessionState.status === 'qr_required') {
      return res.json(getSessionSnapshot());
    }

    await ensureClientInitialized();
    return res.json(getSessionSnapshot());
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to connect session',
      details: error?.message
    });
  }
});

app.post('/api/whatsapp/session/disconnect', async (_req, res) => {
  try {
    await disconnectClientSession();
    return res.json(getSessionSnapshot());
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to disconnect session',
      details: error?.message
    });
  }
});

app.get('/api/whatsapp/instances', (_, res) => {
  res.json({
    instances: [getInstanceSummary()]
  });
});

app.get('/api/whatsapp/contacts', async (_, res) => {
  try {
    if (sessionState.status === 'ready' && Date.now() - getLastContactsRefreshAt() >= CONTACTS_REFRESH_COOLDOWN_MS) {
      await refreshContactsFromChats();
      broadcast('contacts_updated', { contacts: Array.from(contactsByJid.values()) });
    }

    res.json({
      instanceName,
      contacts: Array.from(contactsByJid.values())
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load contacts',
      details: error.message
    });
  }
});

app.get('/api/whatsapp/contacts/:jid/photo', async (req, res) => {
  try {
    const jid = normalizeJid(req.params.jid || '');
    if (!jid) {
      return res.status(400).json({ error: 'Invalid jid' });
    }

    const photoUrl = await fetchProfilePhotoUrl(jid);
    return res.json({ jid, photoUrl });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load photo', details: error.message });
  }
});

app.post('/api/whatsapp/chats/:jid/seen', async (req, res) => {
  try {
    if (sessionState.status !== 'ready') {
      return res.status(409).json({ error: 'WhatsApp session is not ready yet' });
    }

    const jid = normalizeJid(decodeURIComponent(req.params.jid || ''));
    if (!jid) {
      return res.status(400).json({ error: 'Invalid jid' });
    }

    resetUnreadCount(jid);

    try {
      const chat = await client.getChatById(jid);
      if (chat) {
        await chat.sendSeen();
      }
    } catch (err) {
      console.warn('[whatsapp-webjs-bridge] sendSeen falhou para', jid, '-', err?.message || String(err));
    }

    return res.json({ jid, ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to mark as seen', details: error?.message });
  }
});

app.get('/api/whatsapp/labels', async (_, res) => {
  try {
    if (sessionState.status !== 'ready') {
      return res.json({ labels: [] });
    }

    const labelsMap = await loadLabelsMap();
    const labels = [];

    if (typeof client.getLabels === 'function') {
      try {
        const rawLabels = await client.getLabels();
        (rawLabels || []).forEach(label => {
          const id = String(label?.id ?? label?._data?.id ?? '').trim();
          const name = String(label?.name ?? label?._data?.name ?? '').trim();
          const hexColor = String(label?.hexColor ?? label?._data?.hexColor ?? '').trim();
          if (id && name) {
            labels.push({ id, name, hexColor: hexColor || null });
          }
        });
      } catch {
        // Fall back to labelsMap without colors
        for (const [id, name] of labelsMap.entries()) {
          labels.push({ id, name, hexColor: null });
        }
      }
    }

    return res.json({ instanceName, labels });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load labels', details: error?.message });
  }
});

app.get('/api/whatsapp/events', async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

  try {
    if (events.length === 0) {
      await seedEventsFromRecentChats();
    }

    const historyEvents = enableHistoryEvents ? await loadRecentChatEvents(limit) : [];
    const merged = new Map();

    // Prefer real-time in-memory events when IDs collide with history.
    [...events, ...historyEvents].forEach(event => {
      if (!merged.has(event.id)) {
        merged.set(event.id, event);
      }
    });

    const sorted = Array.from(merged.values())
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);

    res.json({
      instanceName,
      events: sorted
    });
  } catch (error) {
    // As a fallback, return in-memory events instead of failing the request.
    res.json({
      instanceName,
      events: events.slice(0, limit)
    });
  }
});

app.get('/api/whatsapp/chats/:jid/messages', async (req, res) => {
  const limit = Math.max(1, Math.min(300, Number(req.query.limit || 120)));
  const deep = String(req.query.deep || '').toLowerCase() === '1'
    || String(req.query.deep || '').toLowerCase() === 'true';
  const debug = String(req.query.debug || '').toLowerCase() === '1'
    || String(req.query.debug || '').toLowerCase() === 'true';

  await acquireHistorySlot();
  try {
    if (sessionState.status !== 'ready') {
      return res.status(409).json({ error: 'WhatsApp session is not ready yet' });
    }

    const requestedJid = normalizeRequestedChatJid(decodeURIComponent(req.params.jid || ''));
    if (!requestedJid) {
      return res.status(400).json({ error: 'Invalid chat jid' });
    }

    const chats = await resolveChatsForHistory(requestedJid);
    if (!chats.length) {
      return res.json({
        instanceName,
        events: [],
        ...(debug
          ? {
            debug: {
              requestedJid,
              deep,
              limit,
              resolvedChats: [],
              stages: []
            }
          }
          : {})
      });
    }

    const chatsToLoad = deep ? chats.slice(0, 3) : chats.slice(0, 1);
    const history = [];
    const seenMessageIds = new Set();
    const stages = [];

    for (const chat of chatsToLoad) {
      const stage = debug
        ? {
          chatId: chat?.id?._serialized || '',
          chatName: typeof chat?.name === 'string' ? chat.name : ''
        }
        : null;
      const partial = await fetchChatHistoryWithRecovery(chat, requestedJid, limit, stage)
        .catch(error => {
          if (stage) {
            stage.fatalError = error?.message || String(error);
          }
          return [];
        });

      if (stage) {
        stage.resultCount = Array.isArray(partial) ? partial.length : 0;
        stages.push(stage);
      }

      (partial || []).forEach(message => {
        const serializedId = getSerializedMessageId(message);
        if (serializedId) {
          if (seenMessageIds.has(serializedId)) {
            return;
          }
          seenMessageIds.add(serializedId);
        }
        history.push(message);
      });
    }

    history.sort((a, b) => readMessageTimestampSeconds(a) - readMessageTimestampSeconds(b));
    if (history.length > limit) {
      history.splice(0, history.length - limit);
    }

    const eventsHistory = (history || [])
      .filter(message => !message.isNotification && !isBlankMessage(message))
      .map(message => {
        const inlineImageDataUrl = readMessageInlineImageDataUrl(message);
        const mediaMimetypeFromData = typeof message?._data?.mimetype === 'string' ? message._data.mimetype.trim() : '';
        const mediaMimetypeFromInline = inlineImageDataUrl
          ? (inlineImageDataUrl.match(/^data:([^;,]+)/i)?.[1] || '')
          : '';
        const mediaMimetype = mediaMimetypeFromData || mediaMimetypeFromInline;
        const mediaFilename = typeof message?._data?.filename === 'string' ? message._data.filename : '';
        const timestamp = readMessageTimestampSeconds(message);
        const receivedAt = timestamp > 0
          ? new Date(timestamp * 1000).toISOString()
          : new Date().toISOString();
        const serializedId = getSerializedMessageId(message) || randomUUID();
        const hasMedia = Boolean(message.hasMedia) || Boolean(mediaMimetype) || Boolean(inlineImageDataUrl);

        const ack = typeof message.ack === 'number' ? message.ack : null;
        return {
          id: serializedId,
          source: 'webjs-chat-history',
          receivedAt,
          isFromMe: resolveIsFromMe(message),
          chatJid: requestedJid,
          phone: normalizePhone(requestedJid),
          text: readMessageText(message),
          ack,
          payload: {
            id: serializedId,
            timestamp,
            type: message.type || '',
            hasMedia,
            mediaMimetype,
            mediaFilename,
            mediaDataUrl: inlineImageDataUrl,
            ack
          }
        };
      })
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

    return res.json({
      instanceName,
      events: eventsHistory,
      ...(debug
        ? {
          debug: {
            requestedJid,
            deep,
            limit,
            loadedChats: chatsToLoad.length,
            resolvedChats: chats.map(chat => ({
              id: chat?.id?._serialized || '',
              name: typeof chat?.name === 'string' ? chat.name : ''
            })),
            stages,
            totalMergedMessages: history.length,
            totalEvents: eventsHistory.length
          }
        }
        : {})
    });
  } catch (error) {
    const requestedJid = normalizeRequestedChatJid(decodeURIComponent(req.params.jid || ''));
    console.warn(
      '[whatsapp-webjs-bridge] fallback de historico por conversa:',
      requestedJid,
      '-',
      error?.message || String(error)
    );
    return res.json({
      instanceName,
      events: events
        .filter(event => isSameConversationJid(event.chatJid, requestedJid))
        .slice(0, limit)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    });
  } finally {
    releaseHistorySlot();
  }
});

app.post('/api/whatsapp/messages', async (req, res) => {
  try {
    if (sessionState.status !== 'ready') {
      return res.status(409).json({ error: 'WhatsApp session is not ready yet' });
    }

    const to = typeof req.body.to === 'string' ? req.body.to : '';
    const text = typeof req.body.text === 'string' ? req.body.text : '';

    if (!to || !text) {
      return res.status(400).json({ error: 'Fields "to" and "text" are required' });
    }

    const chatId = normalizeJid(to);
    if (!chatId) {
      return res.status(400).json({ error: 'Invalid destination number' });
    }

    if (isSelfJid(chatId)) {
      return res.status(400).json({
        error: 'Destination matches the current WhatsApp account',
        details: 'Envio para o proprio numero foi bloqueado para evitar autoenvio.'
      });
    }

    const sent = await client.sendMessage(chatId, text);

    pushEvent({
      id: sent.id?._serialized || '',
      source: 'send-api',
      isFromMe: true,
      chatJid: chatId,
      text,
      receivedAt: toIsoFromUnixTimestamp(sent.timestamp),
      payload: {
        id: sent.id?._serialized || '',
        timestamp: sent.timestamp || 0,
        ack: sent.ack || 0
      }
    });

    if (!contactsByJid.has(chatId)) {
      const phone = normalizePhone(chatId);
      contactsByJid.set(chatId, {
        jid: chatId,
        phone,
        name: phone,
        found: true,
        lastMessageAt: new Date().toISOString()
      });
    } else {
      const existing = contactsByJid.get(chatId);
      contactsByJid.set(chatId, {
        ...existing,
        lastMessageAt: new Date().toISOString()
      });
    }

    return res.json({
      instanceName,
      result: {
        id: sent.id?._serialized || '',
        to: sent.to || chatId,
        timestamp: sent.timestamp || 0
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to send message',
      details: error.message
    });
  }
});

app.post('/api/whatsapp/messages/media', upload.single('file'), async (req, res) => {
  try {
    if (sessionState.status !== 'ready') {
      return res.status(409).json({ error: 'WhatsApp session is not ready yet' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Field "file" is required' });
    }

    const to = typeof req.body.to === 'string' ? req.body.to : '';
    const caption = typeof req.body.caption === 'string' ? req.body.caption : '';

    if (!to) {
      return res.status(400).json({ error: 'Field "to" is required' });
    }

    const chatId = normalizeJid(to);
    if (!chatId) {
      return res.status(400).json({ error: 'Invalid destination number' });
    }

    if (isSelfJid(chatId)) {
      return res.status(400).json({
        error: 'Destination matches the current WhatsApp account',
        details: 'Envio para o proprio numero foi bloqueado para evitar autoenvio.'
      });
    }

    const mimetype = file.mimetype || 'application/octet-stream';
    const media = new MessageMedia(
      mimetype,
      file.buffer.toString('base64'),
      file.originalname || 'arquivo'
    );

    const isImage = mimetype.startsWith('image/');
    const options = {
      caption: caption || undefined,
      sendMediaAsDocument: !isImage
    };

    const sent = await client.sendMessage(chatId, media, options);

    pushEvent({
      id: sent.id?._serialized || '',
      source: 'send-media-api',
      isFromMe: true,
      chatJid: chatId,
      text: caption,
      receivedAt: toIsoFromUnixTimestamp(sent.timestamp),
      payload: {
        id: sent.id?._serialized || '',
        timestamp: sent.timestamp || 0,
        ack: sent.ack || 0,
        hasMedia: true,
        mediaMimetype: mimetype,
        mediaFilename: file.originalname || '',
        mediaDataUrl: isImage
          ? `data:${mimetype};base64,${file.buffer.toString('base64')}`
          : null
      }
    });

    if (!contactsByJid.has(chatId)) {
      const phone = normalizePhone(chatId);
      contactsByJid.set(chatId, {
        jid: chatId,
        phone,
        name: phone,
        found: true,
        lastMessageAt: new Date().toISOString()
      });
    } else {
      const existing = contactsByJid.get(chatId);
      contactsByJid.set(chatId, {
        ...existing,
        lastMessageAt: new Date().toISOString()
      });
    }

    return res.json({
      instanceName,
      result: {
        id: sent.id?._serialized || '',
        to: sent.to || chatId,
        timestamp: sent.timestamp || 0
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to send media',
      details: error.message
    });
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo excede o limite de 50MB' });
  }

  return res.status(500).json({ error: 'Unexpected error', details: err?.message });
});

const httpServer = app.listen(port, async () => {
  console.log(`[whatsapp-webjs-bridge] listening on http://localhost:${port}`);

  createWebSocketServer(httpServer, { allowedOrigins });
  setOnEventPushed(event => broadcast('new_message', event));
  console.log('[whatsapp-webjs-bridge] WebSocket server attached.');

  try {
    await ensureClientInitialized();
  } catch (error) {
    sessionState.status = 'init_error';
    sessionState.lastError = error.message;
    console.error('[whatsapp-webjs-bridge] Falha ao inicializar cliente:', error.message);
  }
});

httpServer.on('error', error => {
  if (error?.code === 'EADDRINUSE') {
    console.warn(`[whatsapp-webjs-bridge] porta ${port} ja esta em uso. Usando instancia existente.`);
    process.exit(0);
    return;
  }

  console.error('[whatsapp-webjs-bridge] erro no servidor HTTP:', error.message);
  process.exit(1);
});
