#!/usr/bin/env node
/*
 * Baixa a telemetria do Firestore para um arquivo JSON e imprime um resumo.
 *
 * Uso:
 *   npm run logs                       -> último dia
 *   npm run logs -- --dias 3           -> últimos 3 dias
 *   npm run logs -- --desde 2026-09-24T08:00:00
 *   npm run logs -- --env production   -> só produção (padrão: todos)
 *   npm run logs -- --chave C:\caminho\chave-admin.json
 *
 * A chave de administrador (conta de serviço do Firebase) é procurada em:
 *   --chave, variável UNIQ_FIREBASE_SERVICE_ACCOUNT, ou
 *   <pasta do usuário>/.uniq-system/firebase-admin.json
 * Ela nunca deve ir para o git nem para o instalador.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGE_SIZE = 300;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) {
      continue;
    }
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : 'true';
    args[key.slice(2)] = value;
    if (value !== 'true') {
      index += 1;
    }
  }
  return args;
}

function resolveKeyPath(args) {
  const candidates = [
    args.chave,
    process.env.UNIQ_FIREBASE_SERVICE_ACCOUNT,
    path.join(os.homedir(), '.uniq-system', 'firebase-admin.json')
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      'Chave de administrador não encontrada. Salve o JSON da conta de serviço em '
      + `${path.join(os.homedir(), '.uniq-system', 'firebase-admin.json')} ou use --chave <caminho>.`
    );
  }
  return found;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(serviceAccount.private_key).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    })
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`Falha ao autenticar no Google: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = decodeValue(value);
  }
  return result;
}

async function fetchBatches(projectId, token, sinceIso) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const documents = [];
  let cursor = null;

  while (true) {
    const structuredQuery = {
      from: [{ collectionId: 'telemetry' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'sentAt' },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { timestampValue: sinceIso }
        }
      },
      orderBy: [
        { field: { fieldPath: 'sentAt' }, direction: 'ASCENDING' },
        { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }
      ],
      limit: PAGE_SIZE
    };
    if (cursor) {
      structuredQuery.startAt = { values: cursor, before: false };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const rows = await response.json();
    if (!response.ok) {
      throw new Error(`Falha ao consultar o Firestore: ${JSON.stringify(rows)}`);
    }

    const page = rows.filter(row => row.document).map(row => row.document);
    documents.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }
    const last = page[page.length - 1];
    cursor = [last.fields.sentAt, { referenceValue: last.name }];
  }

  return documents;
}

function flattenEvents(documents, envFilter) {
  const events = [];
  for (const document of documents) {
    const batch = decodeFields(document.fields || {});
    if (envFilter !== 'todos' && batch.env !== envFilter) {
      continue;
    }
    for (const event of batch.events || []) {
      events.push({
        ts: event.ts,
        name: event.name,
        src: event.src,
        session: event.sid,
        seq: event.seq,
        install: batch.installId,
        host: batch.hostname,
        version: batch.appVersion,
        env: batch.env,
        ...(event.data || {})
      });
    }
  }
  return events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || (a.seq || 0) - (b.seq || 0));
}

function printSummary(events) {
  const counts = new Map();
  for (const event of events) {
    counts.set(event.name, (counts.get(event.name) || 0) + 1);
  }

  console.log(`\n${events.length} eventos`);
  console.log('\nPor tipo:');
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
    console.log(`  ${String(count).padStart(6)}  ${name}`);
  });

  const errors = events.filter(event => event.name.startsWith('error.') || event.ok === false);
  if (errors.length) {
    console.log(`\nErros (${errors.length}, últimos 15):`);
    errors.slice(-15).forEach(event => {
      console.log(`  ${event.ts}  ${event.name}  ${event.message || ''}`);
    });
  }

  const sessions = new Map();
  for (const event of events) {
    if (event.name === 'session.status' || event.name === 'session.disconnected' || event.name === 'app.start' || event.name === 'bridge.exit') {
      const list = sessions.get(event.session) || [];
      list.push(event);
      sessions.set(event.session, list);
    }
  }
  if (sessions.size) {
    console.log('\nLinha do tempo da sessão do WhatsApp:');
    for (const [session, list] of sessions) {
      console.log(`  sessão ${session}`);
      list.forEach(event => {
        const detail = event.name === 'session.status'
          ? `${event.from} -> ${event.to} (ficou ${Math.round((event.msInPrevious || 0) / 1000)}s em ${event.from})`
          : event.name === 'session.disconnected'
            ? `desconectado: ${event.reason}`
            : event.name === 'bridge.exit'
              ? `bridge saiu (code ${event.code})`
              : `app ${event.version} iniciado`;
        console.log(`    ${event.ts}  ${detail}`);
      });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keyPath = resolveKeyPath(args);
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const projectId = args.projeto || serviceAccount.project_id;
  const days = Number(args.dias || 1);
  const since = args.desde ? new Date(args.desde) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) {
    throw new Error('Data inválida em --desde.');
  }
  const envFilter = args.env || 'todos';

  console.log(`Buscando telemetria de ${projectId} desde ${since.toISOString()} (env: ${envFilter})...`);
  const token = await getAccessToken(serviceAccount);
  const documents = await fetchBatches(projectId, token, since.toISOString());
  const events = flattenEvents(documents, envFilter);

  const outputDir = path.join(__dirname, '..', 'telemetry-exports');
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const outputFile = args.saida || path.join(outputDir, `telemetria-${stamp}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(events, null, 2));

  printSummary(events);
  console.log(`\nArquivo salvo em: ${outputFile}`);
}

main().catch(error => {
  console.error(`\nErro: ${error.message}`);
  process.exit(1);
});
