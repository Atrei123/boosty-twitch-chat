#!/usr/bin/env node
/*
 * Boosty Twitch Chat — локальный relay.
 * Без зависимостей: нужен только Node.js 18+.
 *
 *   node server.js            → http://127.0.0.1:8787
 *   PORT=9000 node server.js  → другой порт
 *
 * POST /push     ← сюда шлёт сообщения расширение / userscript со страницы Boosty
 * GET  /events   → Server-Sent Events для оверлея
 * GET  /overlay  → оверлей для OBS (Browser Source)
 * GET  /         → настройка оверлея и превью
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const KEEP = 150;            // сколько последних сообщений отдавать новому оверлею
const MAX_BODY = 2 * 1024 * 1024;

const recent = [];           // последние сообщения
const clients = new Set();   // открытые SSE-соединения
let lastPushAt = 0;
let lastSource = '';

// Настройки оверлея со страницы настройки. Хранятся рядом с server.js и переживают перезапуск.
// Формат — строка параметров, как в адресе: "font=22&bg=dark".
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let savedQuery = '';
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (typeof s.query === 'string') savedQuery = s.query;
} catch { /* файла ещё нет — настройки по умолчанию */ }

function saveSettings(query) {
  savedQuery = query;
  fs.writeFile(SETTINGS_FILE, JSON.stringify({ query }, null, 2), (err) => {
    if (err) console.error('Не удалось сохранить настройки:', err.message);
  });
}

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/overlay': ['overlay.html', 'text/html; charset=utf-8'],
  '/overlay.html': ['overlay.html', 'text/html; charset=utf-8'],
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(line);
}

function isValidMessage(m) {
  return m && typeof m === 'object' && typeof m.id === 'string' && m.id.length < 100 && Array.isArray(m.parts || []);
}

function contentKey(m) {
  return JSON.stringify([m.kind, m.name, m.time, m.parts]);
}

function applyEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'message' && isValidMessage(ev.msg)) {
    if (recent.some((m) => m.id === ev.msg.id)) return;
    // Страница Boosty перезагрузилась — расширение заново шлёт всё, что видит, как историю.
    // То, что уже есть в оверлее, повторно не показываем.
    if (ev.msg.history) {
      const key = contentKey(ev.msg);
      if (recent.some((m) => contentKey(m) === key)) return;
    }
    recent.push(ev.msg);
    if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
    broadcast({ type: 'message', msg: ev.msg });
  } else if (ev.type === 'delete' && typeof ev.id === 'string') {
    const m = recent.find((x) => x.id === ev.id);
    if (m) m.deleted = true;
    broadcast({ type: 'delete', id: ev.id });
  } else if (ev.type === 'clear') {
    recent.length = 0;
    broadcast({ type: 'clear' });
  }
}

const server = http.createServer((req, res) => {
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/push') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(res, 400, { ok: false, error: 'bad json' });
      }
      lastPushAt = Date.now();
      if (typeof body.source === 'string') lastSource = body.source.slice(0, 200);
      for (const ev of Array.isArray(body.events) ? body.events : []) applyEvent(ev);
      send(res, 200, { ok: true, clients: clients.size });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'replay', messages: recent })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'status', ...status() })}\n\n`), 5000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, status());

  if (req.method === 'GET' && url.pathname === '/settings') return send(res, 200, { query: savedQuery });

  if (req.method === 'POST' && url.pathname === '/settings') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', () => {
      let query;
      try {
        query = JSON.parse(body || '{}').query;
      } catch {
        return send(res, 400, { ok: false, error: 'bad json' });
      }
      if (typeof query !== 'string' || query.length > 4000) return send(res, 400, { ok: false, error: 'bad query' });
      query = new URLSearchParams(query).toString(); // нормализуем
      if (query !== savedQuery) {
        saveSettings(query);
        broadcast({ type: 'settings' }); // открытые оверлеи (в том числе в OBS) перечитают настройки
      }
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && files[url.pathname]) {
    const [file, type] = files[url.pathname];
    return fs.readFile(path.join(__dirname, file), (err, data) => (err ? send(res, 500, String(err)) : send(res, 200, data, type)));
  }

  send(res, 404, { ok: false, error: 'not found' });
});

function status() {
  return {
    boostyConnected: Date.now() - lastPushAt < 10000,
    lastPushAt,
    source: lastSource,
    overlays: clients.size,
    messages: recent.length,
  };
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Возможно, relay уже запущен. Другой порт: PORT=9000 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log('Boosty Twitch Chat relay запущен');
  console.log(`  Настройка и превью:  ${base}/`);
  console.log(`  Оверлей для OBS:     ${base}/overlay`);
  console.log('Откройте чат Boosty в браузере с установленным расширением — сообщения пойдут сюда.');
});
