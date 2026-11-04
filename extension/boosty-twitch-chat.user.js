// ==UserScript==
// @name         Boosty Chat — Twitch-style
// @namespace    boosty-twitch-chat
// @version      1.0.0
// @description  Чат Boosty в стиле Twitch + передача сообщений в OBS-оверлей через локальный relay
// @match        https://boosty.to/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// ==/UserScript==

/*
 * Один и тот же файл работает и как userscript (Tampermonkey / Violentmonkey),
 * и как content script расширения Chrome (папка extension/).
 *
 * Как это работает:
 *  1. Boosty сам держит соединение с чатом и рисует сообщения в DOM.
 *     Мы читаем их по стабильным атрибутам data-test-id="CHATMESSAGE:*"
 *     (имена CSS-классов у Boosty генерируются и меняются при каждом релизе).
 *  2. Поверх области сообщений рисуем свой список в стиле Twitch.
 *  3. Каждое сообщение отправляем на локальный relay (relay/server.js),
 *     который отдаёт оверлей для OBS: http://127.0.0.1:8787/overlay
 */
(() => {
  'use strict';
  if (window.__boostyTwitchChat) return;
  window.__boostyTwitchChat = true;

  // ---------------------------------------------------------------- settings
  const STORE_KEY = 'boosty-twitch-chat:v1';
  const DEFAULTS = {
    view: true,            // показывать Twitch-вид поверх чата Boosty
    fontSize: 14,
    timestamps: true,
    avatars: false,
    relay: true,           // отправлять сообщения в локальный relay для OBS
    relayUrl: 'http://127.0.0.1:8787',
  };
  const settings = loadSettings();

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  }

  // --------------------------------------------------------------- selectors
  const SEL = {
    message: '[data-test-id="CHATMESSAGE:root"]',
    system: '[class*="ChatSystemMessage-scss--module_root"]',
    author: '[data-test-id="CHATMESSAGE:author"]',
    text: '[data-test-id="CHATMESSAGE:message"]',
    reply: '[data-test-id="CHATMESSAGE:reply"]',
    time: '[class*="module_publishTime"]',
    avatar: '[class*="module_avatar"]',
    chatRoot: '[data-test-id="CHAT:root"]',
    chatList: '[data-test-id="CHAT:messages"]',
    publisher: '#chat-pub-root',
  };
  const ANY_MESSAGE = `${SEL.message}, ${SEL.system}`;

  // Палитра ников Boosty — запасной вариант, если у имени нет inline-цвета.
  const PALETTE = ['#D66E34', '#B8AAFF', '#00579F', '#8B3FFD', '#59A840', '#D45124', '#DE6489', '#20BBA1',
    '#F8B301', '#0099BB', '#7BBEFF', '#E542FF', '#A36C59', '#8BA259', '#00A9FF', '#A20BFF'];

  // ----------------------------------------------------------------- parsing
  function clean(s) {
    return String(s || '').replace(/\s+/g, ' ');
  }

  function isSkipped(el) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'svg') return true;
    const testId = (el.getAttribute('data-test-id') || '').toLowerCase();
    if (testId.includes('tooltip') || testId.includes('reply')) return true;
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).toLowerCase();
    // Boosty кладёт внутрь текста скрытый тултип смайла с текстом ":heart:".
    return cls.includes('tooltip') || cls.includes('module_buttons');
  }

  function safeUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch {
      return '';
    }
  }

  /** Превращает DOM сообщения в список частей: text / emote / mention / link. */
  function extractParts(container) {
    const parts = [];
    const pushText = (t) => {
      if (!t) return;
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') last.text += t;
      else parts.push({ type: 'text', text: t });
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          pushText(clean(child.nodeValue));
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE || isSkipped(child)) continue;
        const tag = child.tagName;
        if (tag === 'IMG') {
          const src = safeUrl(child.currentSrc || child.getAttribute('src') || '');
          const alt = child.getAttribute('alt') || child.getAttribute('data-id') || '';
          if (src) parts.push({ type: 'emote', src, alt });
          else pushText(alt);
        } else if (child.hasAttribute('data-mention-id') || child.classList.contains('mention')) {
          parts.push({ type: 'mention', text: clean(child.getAttribute('data-display-name') || child.textContent).trim() });
        } else if (tag === 'A') {
          const href = safeUrl(child.getAttribute('href') || '');
          const text = clean(child.textContent).trim() || href;
          if (href) parts.push({ type: 'link', href, text });
          else pushText(text);
        } else if (tag === 'BR') {
          pushText(' ');
        } else {
          const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
          if (block) pushText(' ');
          walk(child);
          if (block) pushText(' ');
        }
      }
    };
    walk(container);
    // Схлопываем пробелы на стыках и обрезаем края.
    for (const p of parts) if (p.type === 'text') p.text = p.text.replace(/\s+/g, ' ');
    if (parts[0] && parts[0].type === 'text') parts[0].text = parts[0].text.replace(/^\s+/, '');
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') last.text = last.text.replace(/\s+$/, '');
    return parts.filter((p) => p.type !== 'text' || p.text);
  }

  function detectRole(root, authorEl) {
    const scope = (authorEl && authorEl.parentElement) || root;
    for (const use of scope.querySelectorAll('use')) {
      if (use.closest(`${SEL.text}, ${SEL.reply}, button`)) continue;
      const href = (use.getAttribute('href') || use.getAttribute('xlink:href') || '').toLowerCase();
      if (/#icon-star/.test(href)) return 'streamer';
      if (/#icon-sword/.test(href)) return 'moderator';
    }
    return '';
  }

  function extractAvatar(root) {
    const box = root.querySelector(SEL.avatar);
    if (!box) return '';
    const img = box.tagName === 'IMG' ? box : box.querySelector('img');
    if (img) return safeUrl(img.currentSrc || img.src);
    const m = /url\(["']?([^"')]+)["']?\)/.exec(box.style.backgroundImage || '');
    return m ? safeUrl(m[1]) : '';
  }

  function hashColor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function parseMessage(root) {
    if (!root.matches(SEL.message)) {
      return { kind: 'system', parts: extractParts(root) };
    }
    const authorEl = root.querySelector(SEL.author);
    const name = clean(authorEl ? authorEl.textContent : '').trim().replace(/:\s*$/, '').trim();
    const textEl = root.querySelector(SEL.text);
    const replyEl = root.querySelector(SEL.reply);
    const cls = String(root.className);
    let reply = null;
    if (replyEl) {
      const spans = [...replyEl.querySelectorAll('span')].map((s) => clean(s.textContent).trim()).filter(Boolean);
      reply = { author: spans[0] || '', text: spans.slice(1).join(' ') || clean(replyEl.textContent).trim() };
    }
    return {
      kind: 'chat',
      name,
      color: (authorEl && authorEl.style.color) || hashColor(name),
      role: detectRole(root, authorEl),
      time: clean((root.querySelector(SEL.time) || {}).textContent).trim(),
      avatar: extractAvatar(root),
      parts: textEl ? extractParts(textEl) : [],
      reply,
      mentionsMe: /hasRootMention/.test(cls),
      isPrivate: /module_private/.test(cls),
      deleted: /msgBanned|userBanned/.test(cls),
    };
  }

  function signature(m) {
    return JSON.stringify([m.kind, m.name, m.time, m.parts]);
  }

  // ------------------------------------------------------------------- store
  const MAX_MESSAGES = 500;
  const sessionPrefix = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const nodeInfo = new WeakMap(); // DOM-узел Boosty -> { id, sig }
  const messages = [];            // упорядоченный список наших записей
  const sigIds = new Map();       // содержимое сообщения -> id наших записей с таким содержимым
  const listeners = [];
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  const indexOf = (id) => messages.findIndex((r) => r.id === id);

  /*
   * Когда чат Boosty подвисает и переподключается, он заново рисует весь список:
   * DOM-узлы новые, а сообщения те же. Поэтому узнаём сообщение не только по узлу,
   * но и по содержимому (ник, время, текст): узел без пометки сопоставляем с уже
   * известной записью с тем же содержимым, которая стоит в ленте после предыдущего
   * сообщения и ещё не занята другим узлом. Так перерисовка не даёт повторов,
   * а настоящий повтор («+» от того же человека в ту же минуту) проходит как новое.
   */
  function findKnown(sig, prevId, claimed) {
    const ids = sigIds.get(sig);
    if (!ids) return null;
    const prevIndex = prevId ? indexOf(prevId) : -1;
    for (const id of ids) {
      if (claimed.has(id)) continue;
      const i = indexOf(id);
      if (i > prevIndex) return messages[i];
    }
    return null;
  }

  function scan(isInitial) {
    const nodes = document.querySelectorAll(ANY_MESSAGE);
    let prevId = null;
    const claimed = new Set(); // записи, уже сопоставленные с узлами в этом проходе
    for (const node of nodes) {
      if (uiHost && uiHost.contains(node)) continue;
      const known = nodeInfo.get(node);
      const msg = parseMessage(node);
      if (msg.kind === 'chat' && !msg.name && !msg.parts.length) continue; // ещё не дорендерилось
      const sig = signature(msg);

      let rec = null;
      if (known && known.sig === sig && !claimed.has(known.id)) rec = messages.find((r) => r.id === known.id) || null;
      if (!rec) rec = findKnown(sig, prevId, claimed);
      if (rec) {
        nodeInfo.set(node, { id: rec.id, sig });
        claimed.add(rec.id);
        if (Boolean(rec.deleted) !== msg.deleted) {
          rec.deleted = msg.deleted;
          emit({ type: msg.deleted ? 'delete' : 'update', id: rec.id, msg: rec });
        }
        prevId = rec.id;
        continue;
      }

      // Новое сообщение.
      const id = `${sessionPrefix}-${++seq}`;
      nodeInfo.set(node, { id, sig });
      claimed.add(id);
      if (!sigIds.has(sig)) sigIds.set(sig, []);
      sigIds.get(sig).push(id);
      const prevIndex = prevId ? messages.findIndex((r) => r.id === prevId) : -1;
      const atEnd = prevIndex === messages.length - 1;
      const fresh = { id, ...msg, ts: Date.now(), history: Boolean(isInitial || !atEnd) };
      messages.splice(prevIndex + 1, 0, fresh);
      emit({ type: 'message', msg: fresh, afterId: prevId });
      prevId = id;
    }
    while (messages.length > MAX_MESSAGES) {
      const removed = messages.shift();
      const sig = signature(removed);
      const ids = (sigIds.get(sig) || []).filter((x) => x !== removed.id);
      if (ids.length) sigIds.set(sig, ids); else sigIds.delete(sig);
      emit({ type: 'evict', id: removed.id });
    }
  }

  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan(false);
    }, 60);
  }

  // ------------------------------------------------------------------- relay
  const relayQueue = [];
  let relayState = 'idle'; // idle | ok | offline
  let relayBackoff = 1000;
  let relayBusy = false;

  function post(url, body) {
    return new Promise((resolve, reject) => {
      // Сообщения уходят только на этот компьютер — никаких внешних серверов.
      try {
        if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('not local');
      } catch {
        reject(new Error('relayUrl должен указывать на 127.0.0.1 или localhost'));
        return;
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        // Tampermonkey: запрос идёт из расширения, без CORS и запросов доступа к локальной сети.
        GM_xmlhttpRequest({
          method: 'POST', url, data: body, timeout: 4000,
          headers: { 'Content-Type': 'application/json' },
          onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error(r.status))),
          onerror: reject, ontimeout: reject,
        });
      } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        // Расширение: отправляем через background service worker.
        chrome.runtime.sendMessage({ type: 'btc-post', url, body }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) reject(new Error('relay'));
          else resolve();
        });
      } else {
        fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })
          .then((r) => (r.ok ? resolve() : reject(new Error(r.status))), reject);
      }
    });
  }

  function toRelayEvent(ev) {
    if (ev.type === 'message') {
      const m = ev.msg;
      return { type: 'message', msg: {
        id: m.id, kind: m.kind, name: m.name, color: m.color, role: m.role, time: m.time, avatar: m.avatar,
        parts: m.parts, reply: m.reply, deleted: m.deleted, history: m.history, ts: m.ts,
      } };
    }
    if (ev.type === 'delete') return { type: 'delete', id: ev.id };
    return null;
  }

  listeners.push((ev) => {
    if (!settings.relay) return;
    const out = toRelayEvent(ev);
    if (!out) return;
    relayQueue.push(out);
    // Пока relay выключен, не копим бесконечно — оверлею нужны только свежие.
    if (relayQueue.length > 200) relayQueue.splice(0, relayQueue.length - 200);
  });

  let lastPost = 0;
  async function flushRelay() {
    const later = (ms) => setTimeout(flushRelay, ms);
    if (relayBusy) return later(200);
    if (!settings.relay) { setRelayState('idle'); return later(1000); }
    // Пустой push раз в 3 секунды — это ping, чтобы индикатор статуса был честным.
    if (!relayQueue.length && relayState === 'ok' && Date.now() - lastPost < 3000) return later(150);
    relayBusy = true;
    const batch = relayQueue.splice(0, 100);
    try {
      await post(`${settings.relayUrl.replace(/\/+$/, '')}/push`, JSON.stringify({
        source: location.pathname, events: batch,
      }));
      lastPost = Date.now();
      setRelayState('ok');
      relayBackoff = 1000;
      later(relayQueue.length ? 0 : 150);
    } catch {
      relayQueue.unshift(...batch);
      if (relayQueue.length > 200) relayQueue.splice(0, relayQueue.length - 200);
      setRelayState('offline');
      relayBackoff = Math.min(relayBackoff * 2, 15000);
      later(relayBackoff);
    } finally {
      relayBusy = false;
    }
  }

  function setRelayState(s) {
    relayState = s;
    if (ui) ui.updateStatus();
  }

  // ---------------------------------------------------------------------- UI
  let uiHost = null;
  let ui = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      position: fixed; z-index: 2147483000; display: flex; flex-direction: column;
      background: #18181b; color: #efeff1; overflow: hidden;
      font: 400 var(--fs)/1.43 Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .root[hidden] { display: none; }
    .list { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px 0 10px; overscroll-behavior: contain;
      scrollbar-width: thin; scrollbar-color: #3d3d40 transparent; }
    .line { padding: 4px 20px; overflow-wrap: anywhere; word-break: break-word; }
    .line:hover { background: rgba(255,255,255,.06); }
    .line.me { background: rgba(235, 4, 0, .22); box-shadow: inset 3px 0 0 #eb0400; }
    .line.system { color: #adadb8; font-style: italic; }
    .line.deleted .text { color: #adadb8; font-style: italic; }
    .reply { display: block; color: #adadb8; font-size: .86em; margin-bottom: 1px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .time { color: #adadb8; font-size: .86em; margin-right: 5px; font-variant-numeric: tabular-nums; }
    .avatar { width: 1.3em; height: 1.3em; border-radius: 50%; vertical-align: middle; margin: -.3em 4px 0 0;
      object-fit: cover; }
    .badge { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
      border-radius: 3px; vertical-align: middle; margin: -3px 4px 0 0; }
    .badge svg { width: 12px; height: 12px; fill: #fff; }
    .badge.streamer { background: #e91916; }
    .badge.moderator { background: #00ad03; }
    .name { font-weight: 700; }
    .colon { margin-right: 4px; }
    .emote { height: 1.9em; vertical-align: middle; margin: -.45em 1px; }
    .mention { font-weight: 700; padding: 0 2px; border-radius: 2px; background: rgba(255,255,255,.12); }
    a { color: #bf94ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .paused { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); border: 0; cursor: pointer;
      padding: 6px 12px; border-radius: 6px; background: rgba(24,24,27,.92); color: #efeff1; font: inherit;
      font-weight: 600; box-shadow: 0 2px 10px rgba(0,0,0,.6); outline: 1px solid #3d3d40; }
    .paused[hidden] { display: none; }
    .bar { position: absolute; top: 6px; right: 10px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
    .root:hover .bar, .bar:focus-within { opacity: 1; }
    .bar button, .restore { border: 0; cursor: pointer; border-radius: 4px; padding: 3px 7px; font: 600 12px/1.4 inherit;
      font-family: Inter, Arial, sans-serif; background: rgba(58,58,61,.95); color: #efeff1; }
    .bar button:hover, .restore:hover { background: #53535f; }
    .bar button.on { background: #9147ff; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; vertical-align: 0; background: #adadb8; }
    .dot.ok { background: #00f593; } .dot.offline { background: #eb0400; }
    .restore { position: fixed; z-index: 2147483000; background: #9147ff; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .restore[hidden] { display: none; }
  `;

  const ICONS = {
    streamer: '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>',
    moderator: '<svg viewBox="0 0 24 24"><path d="M12 1.8l8.5 3.2v6.3c0 5.3-3.6 9.8-8.5 11.3-4.9-1.5-8.5-6-8.5-11.3V5z"/></svg>',
  };

  /** Ник может быть слишком тёмным для тёмного фона — осветляем, как это делает Twitch. */
  function readableColor(color) {
    const probe = document.createElement('span');
    probe.style.color = color; // браузер нормализует любой цвет в rgb(...)
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(probe.style.color);
    if (!m) return color;
    let rgb = m.slice(1, 4).map(Number);
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (let i = 0; i < 10 && lum(rgb) < 0.12; i++) rgb = rgb.map((v) => Math.round(v + (255 - v) * 0.18));
    return `rgb(${rgb.join(',')})`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderParts(target, parts) {
    for (const p of parts) {
      if (p.type === 'text') target.append(p.text);
      else if (p.type === 'emote') {
        const img = el('img', 'emote');
        img.src = p.src; img.alt = p.alt; img.title = p.alt; img.loading = 'lazy';
        target.append(img);
      } else if (p.type === 'mention') target.append(el('span', 'mention', `@${p.text}`));
      else if (p.type === 'link') {
        const a = el('a', '', p.text);
        a.href = p.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
        target.append(a);
      }
    }
  }

  function renderLine(m) {
    const line = el('div', 'line');
    line.dataset.id = m.id;
    if (m.kind === 'system') {
      line.classList.add('system');
      renderParts(line, m.parts);
      return line;
    }
    if (m.mentionsMe) line.classList.add('me');
    if (m.deleted) line.classList.add('deleted');
    if (m.reply && (m.reply.author || m.reply.text)) {
      line.append(el('span', 'reply', `↪ ${m.reply.author ? `@${m.reply.author}: ` : ''}${m.reply.text}`));
    }
    if (settings.timestamps && m.time) line.append(el('span', 'time', m.time));
    if (settings.avatars && m.avatar) {
      const img = el('img', 'avatar');
      img.src = m.avatar; img.alt = ''; img.loading = 'lazy';
      line.append(img);
    }
    if (m.role) {
      const b = el('span', `badge ${m.role}`);
      b.title = m.role === 'streamer' ? 'Стример' : 'Модератор';
      b.innerHTML = ICONS[m.role]; // статичная иконка, не пользовательские данные
      line.append(b);
    }
    const name = el('span', 'name', m.name);
    name.style.color = readableColor(m.color);
    line.append(name, el('span', 'colon', ':'));
    const text = el('span', 'text');
    if (m.deleted) text.textContent = '<сообщение удалено>';
    else renderParts(text, m.parts);
    line.append(text);
    return line;
  }

  function createUI() {
    uiHost = document.createElement('boosty-twitch-chat');
    const shadow = uiHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="root">
        <div class="list" role="log" aria-live="polite"></div>
        <button class="paused" hidden>Чат на паузе — к новым сообщениям ↓</button>
        <div class="bar">
          <button data-act="relay" title="Отправка в OBS-оверлей (relay)"><span class="dot"></span>OBS</button>
          <button data-act="smaller" title="Шрифт меньше">A−</button>
          <button data-act="bigger" title="Шрифт больше">A+</button>
          <button data-act="time" title="Время сообщений">🕑</button>
          <button data-act="avatars" title="Аватарки">👤</button>
          <button data-act="off" title="Вернуть обычный чат Boosty (Alt+B)">Boosty</button>
        </div>
      </div>
      <button class="restore" hidden title="Alt+B">Twitch-вид</button>`;
    document.documentElement.append(uiHost);

    const root = shadow.querySelector('.root');
    const list = shadow.querySelector('.list');
    const paused = shadow.querySelector('.paused');
    const restore = shadow.querySelector('.restore');
    const bar = shadow.querySelector('.bar');
    let stick = true;

    const nearBottom = () => list.scrollHeight - list.clientHeight - list.scrollTop < 30;
    let glideRaf = 0;
    const stopGlide = () => { cancelAnimationFrame(glideRaf); glideRaf = 0; };
    const toBottom = () => { stopGlide(); list.scrollTop = list.scrollHeight; };
    // Плавно доезжаем до низа, как в чате Twitch: быстро в начале, мягко в конце.
    // Пачка новых сообщений прокручивается одним плавным движением.
    const glide = () => {
      if (glideRaf) return;
      let prev = performance.now();
      const step = (now) => {
        const dt = Math.min(64, now - prev);
        prev = now;
        const target = list.scrollHeight - list.clientHeight;
        const d = target - list.scrollTop;
        if (d <= 1) { list.scrollTop = target; glideRaf = 0; return; }
        list.scrollTop += Math.max(1, d * (1 - Math.pow(0.82, dt / 16.7)));
        glideRaf = requestAnimationFrame(step);
      };
      glideRaf = requestAnimationFrame(step);
    };
    // Пользователь крутит вверх — прекращаем доводку и ставим чат на паузу.
    const userUp = () => { stopGlide(); stick = false; };
    list.addEventListener('wheel', (e) => { if (e.deltaY < 0) userUp(); }, { passive: true });
    list.addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) userUp(); });
    list.addEventListener('pointerdown', (e) => { if (e.target === list) userUp(); }); // тянут полосу прокрутки
    list.addEventListener('scroll', () => {
      if (glideRaf) return; // это наша доводка, а не пользователь
      stick = nearBottom();
      if (stick) paused.hidden = true;
    }, { passive: true });
    list.addEventListener('load', () => { if (stick) glide(); }, true);
    paused.addEventListener('click', () => { stick = true; paused.hidden = true; toBottom(); });

    function rerenderAll() {
      list.textContent = '';
      for (const m of messages) list.append(renderLine(m));
      toBottom();
    }

    function applySettings() {
      root.style.setProperty('--fs', `${settings.fontSize}px`);
      root.hidden = !settings.view;
      bar.querySelector('[data-act="time"]').classList.toggle('on', settings.timestamps);
      bar.querySelector('[data-act="avatars"]').classList.toggle('on', settings.avatars);
      bar.querySelector('[data-act="relay"]').classList.toggle('on', settings.relay);
      updateStatus();
      position();
    }

    function updateStatus() {
      const dot = bar.querySelector('.dot');
      dot.className = `dot ${settings.relay ? relayState : ''}`;
      bar.querySelector('[data-act="relay"]').title = !settings.relay
        ? 'Отправка в OBS выключена — нажмите, чтобы включить'
        : relayState === 'ok' ? `Relay подключён: ${settings.relayUrl}` : `Relay не запущен (${settings.relayUrl}) — запустите relay/start`;
    }

    bar.addEventListener('click', (e) => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (!act) return;
      if (act === 'smaller') settings.fontSize = Math.max(10, settings.fontSize - 1);
      if (act === 'bigger') settings.fontSize = Math.min(40, settings.fontSize + 1);
      if (act === 'time') settings.timestamps = !settings.timestamps;
      if (act === 'avatars') settings.avatars = !settings.avatars;
      if (act === 'relay') settings.relay = !settings.relay;
      if (act === 'off') settings.view = false;
      saveSettings();
      if (act === 'time' || act === 'avatars') rerenderAll();
      applySettings();
    });
    restore.addEventListener('click', () => { settings.view = true; saveSettings(); applySettings(); toBottom(); });
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.code === 'KeyB')) {
        settings.view = !settings.view; saveSettings(); applySettings(); toBottom();
      }
    });

    /** Встаём ровно поверх списка сообщений Boosty, не закрывая поле ввода. */
    function position() {
      const chat = document.querySelector(SEL.chatRoot);
      const listEl = document.querySelector(SEL.chatList);
      const pub = document.querySelector(SEL.publisher);
      const anyMsg = document.querySelector(SEL.message);
      const visible = Boolean(chat || listEl || anyMsg);
      let r;
      if (listEl && listEl.getBoundingClientRect().height > 50) {
        r = listEl.getBoundingClientRect();
      } else if (chat) {
        r = chat.getBoundingClientRect();
      } else {
        r = { left: 0, top: 0, width: innerWidth, bottom: innerHeight };
      }
      let bottom = r.bottom;
      if (pub) {
        const pr = pub.getBoundingClientRect();
        if (pr.height > 0 && pr.top > r.top + 50) bottom = Math.min(bottom, pr.top);
      }
      Object.assign(root.style, {
        left: `${r.left}px`, top: `${Math.max(0, r.top)}px`, width: `${r.width}px`,
        height: `${Math.max(80, bottom - Math.max(0, r.top))}px`,
      });
      root.hidden = !settings.view || !visible;
      restore.hidden = settings.view || !visible;
      Object.assign(restore.style, { left: `${r.left + r.width - 100}px`, top: `${Math.max(0, r.top) + 8}px` });
      if (stick && !glideRaf && list.scrollHeight - list.clientHeight - list.scrollTop > 1) glide();
    }
    window.addEventListener('resize', position);
    setInterval(position, 700);

    listeners.push((ev) => {
      if (ev.type === 'message') {
        const line = renderLine(ev.msg);
        const after = ev.afterId && list.querySelector(`[data-id="${ev.afterId}"]`);
        if (after) after.after(line);
        else if (ev.afterId === null) list.prepend(line);
        else list.append(line);
        if (stick) glide();
        else if (!ev.msg.history) paused.hidden = false;
      } else if (ev.type === 'delete' || ev.type === 'update') {
        const old = list.querySelector(`[data-id="${ev.id}"]`);
        if (old && ev.msg) old.replaceWith(renderLine(ev.msg));
      } else if (ev.type === 'evict') {
        const old = list.querySelector(`[data-id="${ev.id}"]`);
        if (old) old.remove();
      }
    });

    ui = { updateStatus, position };
    applySettings();
    rerenderAll();
  }

  // -------------------------------------------------------------------- boot
  function boot() {
    createUI();
    scan(true);
    new MutationObserver((records) => {
      for (const r of records) {
        if (uiHost && (r.target === uiHost || uiHost.contains(r.target))) continue;
        scheduleScan();
        return;
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'],
    });
    flushRelay();
    console.info('[Boosty Twitch Chat] запущен. Alt+B — переключить вид. Relay:', settings.relayUrl);
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
