// Быстрая проверка relay без браузера и без зависимостей (подходит для Node.js 18+):
// сервер стартует, слушает только 127.0.0.1, принимает сообщения, раздаёт их
// оверлею по SSE, применяет удаление и отдаёт страницы.
// Запуск: node test/relay-smoke.js
'use strict';
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function openEvents() {
  const events = [];
  const req = http.get(`${BASE}/events`, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    });
  });
  return { events, close: () => req.destroy() };
}

const msg = (id, name, text, extra = {}) => ({
  type: 'message',
  msg: { id, kind: 'chat', name, color: 'rgb(89, 168, 64)', role: '', time: '17:00', parts: [{ type: 'text', text }], ts: Date.now(), ...extra },
});

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    cwd: os.tmpdir(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  relay.stdout.on('data', (c) => { out += c; });
  try {
    for (let i = 0; i < 50 && !out.includes('relay'); i++) await sleep(100);
    assert(out.includes(`127.0.0.1:${PORT}`), 'relay запустился и слушает 127.0.0.1');

    const page = await request('GET', `${BASE}/`);
    assert(page.status === 200 && page.body.includes('<html'), 'страница настройки открывается');
    const overlayPage = await request('GET', `${BASE}/overlay`);
    assert(overlayPage.status === 200 && overlayPage.body.includes('EventSource'), 'страница оверлея открывается');

    const pre = await request('OPTIONS', `${BASE}/push`);
    assert(pre.headers['access-control-allow-private-network'] === 'true', 'preflight разрешает запросы со страницы Boosty');

    const sse = openEvents();
    await sleep(300);
    assert(sse.events.some((e) => e.type === 'replay'), 'оверлей сразу получает последние сообщения (replay)');

    const push = await request('POST', `${BASE}/push`, { source: '/hellyeahplay/streams/only-chat', events: [
      msg('a-1', 'Зритель', 'привет'),
      msg('a-2', 'Спамер', 'спам'),
    ] });
    assert(push.status === 200 && JSON.parse(push.body).ok, 'relay принимает сообщения');
    await sleep(300);
    const got = sse.events.filter((e) => e.type === 'message').map((e) => e.msg.id);
    assert(got.includes('a-1') && got.includes('a-2'), 'оверлей получил оба сообщения');

    await request('POST', `${BASE}/push`, { events: [msg('a-1', 'Зритель', 'привет')] });
    await sleep(200);
    const dup = sse.events.filter((e) => e.type === 'message' && e.msg.id === 'a-1').length;
    assert(dup === 1, 'повторно присланное сообщение не дублируется');

    await request('POST', `${BASE}/push`, { events: [{ type: 'delete', id: 'a-2' }] });
    await sleep(200);
    assert(sse.events.some((e) => e.type === 'delete' && e.id === 'a-2'), 'удаление доходит до оверлея');

    const bad = await request('POST', `${BASE}/push`, 'не json');
    assert(bad.status === 400 || bad.status === 200, 'кривой запрос не роняет relay');
    const status = JSON.parse((await request('GET', `${BASE}/status`)).body);
    assert(status.boostyConnected && status.overlays === 1, 'статус: Boosty подключён, открыт один оверлей');
    sse.close();
    console.log('\nВсе проверки пройдены');
  } finally {
    relay.kill();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
