// Чат Boosty должен оставаться рабочим у того, у кого стоит расширение:
// окно смайлов открывается и кликается, кнопка «Отправить» нажимается,
// сообщения продолжают идти — и в обычном виде, и в Twitch-виде.
// Запуск: node test/boosty-usable.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

(async () => {
  const relay = spawn(process.execPath, [path.join(ROOT, 'relay/server.js')], { stdio: 'ignore' });
  await sleep(500);
  const ext = path.join(ROOT, 'extension');
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'btc-')), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 420, height: 640 },
  });
  try {
    await ctx.route('https://boosty.to/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'mock-boosty.html')) }));
    await ctx.route(/https:\/\/(static|images)\.boosty\.to\/.*/, (r) => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
    const page = await ctx.newPage();
    await page.goto('https://boosty.to/hellyeahplay/streams/only-chat');
    await page.waitForSelector('boosty-twitch-chat', { state: 'attached', timeout: 10000 });
    await sleep(800);

    // Клик «как мышью» по центру элемента: если сверху что-то лежит, клик уйдёт туда.
    const clickLikeUser = async (selector) => {
      const box = await page.locator(selector).first().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const topElementAt = (selector) => page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit ? (hit.closest(sel) ? 'boosty' : hit.tagName.toLowerCase()) : 'none';
    }, selector);

    const useChat = async (label, text) => {
      await clickLikeUser('#smile-btn');
      await sleep(150);
      assert(await page.locator('#smile-picker').evaluate((p) => p.classList.contains('open')), `${label}: окно смайлов открывается`);
      assert((await topElementAt('#smile-picker .smile')) === 'boosty', `${label}: смайл в окне ничем не закрыт`);
      await clickLikeUser('#smile-picker .smile');
      await page.locator('#chat-pub-root textarea').click();
      await page.keyboard.type(` ${text}`);
      assert((await page.inputValue('#chat-pub-root textarea')).startsWith('❤️'), `${label}: смайл вставляется в поле ввода`);
      await clickLikeUser('#smile-btn'); // закрыть окно смайлов
      assert((await topElementAt('#send-btn')) === 'boosty', `${label}: кнопка «Отправить» ничем не закрыта`);
      await clickLikeUser('#send-btn');
      await sleep(600);
      const sent = await page.evaluate((t) => [...document.querySelectorAll('[data-test-id="CHATMESSAGE:root"]')].some((n) => n.textContent.includes(t)), text);
      assert(sent, `${label}: сообщение отправилось и появилось в чате Boosty`);
      const overlay = await (await fetch('http://127.0.0.1:8787/status')).json();
      assert(overlay.messages >= 1, `${label}: сообщения продолжают уходить в OBS (${overlay.messages})`);
    };

    // 1. По умолчанию расширение не меняет чат Boosty: он выглядит и работает как обычно.
    const listHit = await page.evaluate(() => {
      const r = document.querySelector('[data-test-id="CHAT:messages"]').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
      return hit && hit.closest('boosty-twitch-chat') ? 'наш слой' : 'чат Boosty';
    });
    assert(listHit === 'чат Boosty', 'по умолчанию чат Boosty ничем не перекрыт');
    await useChat('обычный вид', 'привет из обычного вида');

    // 2. Twitch-вид включён — Boosty всё равно должен работать.
    await page.keyboard.press('Alt+KeyB');
    await sleep(800);
    const viewOn = await page.evaluate(() => !document.querySelector('boosty-twitch-chat').shadowRoot.querySelector('.root').hidden);
    assert(viewOn, 'Twitch-вид включается по Alt+B');
    await useChat('Twitch-вид', 'привет из твич вида');

    // Худший случай: окно Boosty с маленьким z-index — Twitch-вид всё равно должен уступить.
    await page.addStyleTag({ content: '#smile-picker { z-index: 1 !important; }' });
    await useChat('Twitch-вид, окно Boosty с z-index 1', 'привет при низком z-index');
    const shown = await page.evaluate(() => document.querySelector('boosty-twitch-chat').shadowRoot.textContent.includes('привет из твич вида'));
    assert(shown, 'Twitch-вид: отправленное сообщение видно в Twitch-виде');

    console.log('\nВсе проверки пройдены');
  } finally {
    await ctx.close();
    relay.kill();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
