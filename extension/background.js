// Content script не может сам ходить на http://127.0.0.1 со страницы https://boosty.to
// (mixed content / Local Network Access), поэтому запросы к relay идут отсюда.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'btc-post') return false;
  let url;
  try {
    url = new URL(msg.url);
  } catch {
    sendResponse({ ok: false });
    return false;
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    sendResponse({ ok: false });
    return false;
  }
  fetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: msg.body })
    .then((r) => sendResponse({ ok: r.ok }), () => sendResponse({ ok: false }));
  return true; // ответ асинхронный
});
