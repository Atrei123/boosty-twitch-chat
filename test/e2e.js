// Сквозная проверка: настоящее расширение в Chromium + mock-страница Boosty + relay + оверлей.
// Запуск: node test/e2e.js  (нужен playwright; скриншоты пишутся в test/out/)
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const BOOSTY_URL = 'https://boosty.to/hellyeahplay/streams/only-chat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const relay = spawn(process.execPath, [path.join(ROOT, 'relay/server.js')], { stdio: 'inherit' });
  await sleep(500);

  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'btc-'));
  const ext = path.join(ROOT, 'extension');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium', // новый headless — умеет загружать расширения
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 420, height: 640 },
  });

  try {
    await ctx.route('https://boosty.to/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'mock-boosty.html')) }));
    // Картинки Boosty (смайлы, аватарки) — заглушки, сеть в тесте не нужна.
    const svg = (emoji, bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${bg ? `<rect width="32" height="32" fill="${bg}"/>` : ''}<text x="16" y="25" font-size="24" text-anchor="middle">${emoji}</text></svg>`;
    await ctx.route('https://static.boosty.to/**', (r) => r.fulfill({ contentType: 'image/svg+xml', body: svg('❤️') }));
    await ctx.route('https://images.boosty.to/**', (r) => r.fulfill({ contentType: 'image/svg+xml', body: svg('🙂', '#444') }));

    const overlay = await ctx.newPage();
    await overlay.goto('http://127.0.0.1:8787/overlay?time=1&bg=dark');

    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(BOOSTY_URL);
    await page.waitForSelector('boosty-twitch-chat', { state: 'attached', timeout: 10000 });
    assert(logs.some((l) => l.includes('[Boosty Twitch Chat]')), 'расширение запустилось на странице Boosty');

    await page.evaluate(() => {
      addMsg({ name: 'Модератор_Иван', color: 'rgb(0, 169, 255)', role: 'moderator', time: '17:03',
        html: `Привет <img alt=":heart:" src="${EMOJI}" data-id=":heart:" data-type="smile"> <span class="mention" data-mention-id="1" data-display-name="Зритель_Тест" contenteditable="false">Зритель_Тест</span>!` });
      addMsg({ name: 'hellyeahplay', color: 'rgb(229, 66, 255)', role: 'streamer', time: '17:04',
        reply: ['Зритель_Тест', 'Когда следующий стрим?'], html: 'Завтра в 19:00, ссылка: <a href="https://boosty.to/hellyeahplay">boosty.to/hellyeahplay</a>' });
      window.spam = addMsg({ name: 'Спамер', html: 'КУПИ ПОДПИСЧИКОВ', time: '17:05' });
      addMsg({ name: 'ochen_dlinny_nickname_2026', color: 'rgb(248, 179, 1)', time: '17:05', mention: true,
        html: 'Очень длинное сообщение, чтобы проверить перенос строк в узкой колонке чата и то, что ничего не вылезает за край источника в OBS.' });
    });
    await sleep(1500);

    const view = await page.evaluate(() => {
      const sr = document.querySelector('boosty-twitch-chat').shadowRoot;
      return [...sr.querySelectorAll('.line')].map((l) => l.textContent.trim());
    });
    console.log(view);
    assert(view.length === 7, `Twitch-вид показывает все 7 строк (система + 2 истории + 4 новых), есть ${view.length}`);
    assert(view.some((t) => t.includes('Модератор_Иван:Привет') && t.includes('@Зритель_Тест')), 'упоминание и текст модератора');
    assert(!view.join('\n').includes(':heart:Зритель') && !view.join('').includes(':heart::heart:'), 'текст тултипа смайла не попал в сообщение');
    assert(view.some((t) => t.startsWith('↪ @Зритель_Тест: Когда следующий стрим?')), 'ответ (reply) показан');

    const ov = await overlay.evaluate(() => [...document.querySelectorAll('.line')].map((l) => ({
      text: l.textContent.trim(), badges: [...l.querySelectorAll('.badge')].map((b) => b.className),
      emotes: l.querySelectorAll('.emote').length,
    })));
    console.log(ov);
    assert(ov.length === 6, `оверлей получил 6 сообщений чата, есть ${ov.length}`);
    assert(ov.some((l) => l.badges.includes('badge moderator') && l.emotes === 1), 'у модератора значок и смайл');
    assert(ov.some((l) => l.badges.includes('badge streamer')), 'у стримера значок');

    await overlay.screenshot({ path: path.join(OUT, 'overlay-before-delete.png') });

    // Модератор удаляет спам: Boosty вешает класс msgBanned на корень сообщения.
    await page.evaluate(() => window.spam.classList.add('ChatMessage-scss--module_msgBanned_3BBCc'));
    await sleep(1200);
    const ovAfter = await overlay.evaluate(() => [...document.querySelectorAll('.line')].map((l) => l.textContent));
    assert(!ovAfter.some((t) => t.includes('КУПИ')), 'удалённое сообщение пропало из оверлея');
    const viewAfter = await page.evaluate(() => document.querySelector('boosty-twitch-chat').shadowRoot.querySelector('.line.deleted')?.textContent);
    assert(viewAfter && viewAfter.includes('<сообщение удалено>'), 'в Twitch-виде показано «<сообщение удалено>»');

    // Новый оверлей (перезапуск источника в OBS) получает последние сообщения сразу.
    const overlay2 = await ctx.newPage();
    await overlay2.goto('http://127.0.0.1:8787/overlay?history=0');
    await sleep(500);
    const n2 = await overlay2.locator('.line').count();
    assert(n2 === 3, `history=0: после перезапуска видны только новые сообщения без удалённого (3), есть ${n2}`);

    // Поле ввода Boosty не перекрыто.
    const covered = await page.evaluate(() => {
      const r = document.querySelector('#chat-pub-root textarea').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 10, r.top + 10);
      return hit && hit.tagName;
    });
    assert(covered === 'TEXTAREA', 'поле ввода сообщения Boosty остаётся доступным');

    const status = await (await fetch('http://127.0.0.1:8787/status')).json();
    assert(status.boostyConnected, 'relay видит подключённую страницу Boosty');

    await page.screenshot({ path: path.join(OUT, 'boosty-twitch-view.png') });
    await overlay.goto('http://127.0.0.1:8787/overlay?time=1&font=20');
    await sleep(400);
    await overlay.screenshot({ path: path.join(OUT, 'overlay-transparent.png'), omitBackground: true });
    const builder = await ctx.newPage();
    await builder.setViewportSize({ width: 1100, height: 900 });
    await builder.goto('http://127.0.0.1:8787/');
    await sleep(2500);
    await builder.screenshot({ path: path.join(OUT, 'builder.png') });
    console.log('\nВсе проверки пройдены');
  } finally {
    await ctx.close();
    relay.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
