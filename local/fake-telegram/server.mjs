// Stand-in for the Telegram Bot API in local tests (no real Telegram, no real token).
//   Bot side:  POST /bot<token>/<method>, GET /file/bot<token>/<path>   (what the CRM calls)
//   Test side: POST /_test/update   {message|callback_query}  -> queued for getUpdates
//              POST /_test/file     {file_id, base64}          -> served by getFile (photos, voice messages)
//              GET  /_test/log?since=N                         -> what the bot sent and which files it fetched (getFile)
import { createServer } from 'node:http';

const TOKEN = process.env.FAKE_TG_TOKEN || 'local-test-token';
const updates = [];
const waiters = [];
const files = new Map();
const log = [];
// above any id of an earlier run: the bot keeps its getUpdates offset when only this stand-in restarts
let nextUpdate = Date.now();
let nextMessage = 1000;
let seq = 0;

const record = (entry) => log.push({ seq: ++seq, at: Date.now(), ...entry });

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const ok = (res, result) => send(res, 200, { ok: true, result });

const methods = {
  getMe: () => ({ id: 999000, is_bot: true, first_name: 'Parisa CRM', username: 'parisa_crm_test_bot' }),
  async getUpdates(p) {
    const offset = Number(p.offset || 0);
    while (updates.length && updates[0].update_id < offset) updates.shift();
    if (!updates.length && Number(p.timeout) > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(Number(p.timeout), 25) * 1000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return updates.filter((u) => u.update_id >= offset);
  },
  sendMessage(p) {
    const message = { message_id: ++nextMessage, chat: { id: Number(p.chat_id), type: 'private' }, date: Math.floor(Date.now() / 1000), text: p.text };
    record({ method: 'sendMessage', chat_id: String(p.chat_id), message_id: message.message_id, text: p.text, keyboard: p.reply_markup?.inline_keyboard ?? null });
    return message;
  },
  editMessageText(p) {
    record({ method: 'editMessageText', chat_id: String(p.chat_id), message_id: p.message_id, text: p.text, keyboard: p.reply_markup?.inline_keyboard ?? null });
    return true;
  },
  editMessageReplyMarkup(p) {
    record({ method: 'editMessageReplyMarkup', chat_id: String(p.chat_id), message_id: p.message_id, keyboard: p.reply_markup?.inline_keyboard ?? null });
    return true;
  },
  answerCallbackQuery(p) {
    record({ method: 'answerCallbackQuery', id: p.callback_query_id, text: p.text ?? null });
    return true;
  },
  sendChatAction: () => true,
  getFile(p) {
    record({ method: 'getFile', file_id: p.file_id });
    const file = files.get(p.file_id);
    if (!file) throw Object.assign(new Error('Bad Request: wrong file_id'), { code: 400 });
    return { file_id: p.file_id, file_size: file.length, file_path: `files/${p.file_id}` };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/_test/update' && req.method === 'POST') {
    const update = { update_id: nextUpdate++, ...(await body(req)) };
    updates.push(update);
    waiters.splice(0).forEach((wake) => wake());
    return send(res, 200, { update_id: update.update_id });
  }
  if (url.pathname === '/_test/file' && req.method === 'POST') {
    const { file_id, base64 } = await body(req);
    files.set(file_id, Buffer.from(base64, 'base64'));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/_test/log') {
    const since = Number(url.searchParams.get('since') || 0);
    return send(res, 200, { seq, entries: log.filter((e) => e.seq > since) });
  }

  const fileMatch = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(url.pathname);
  if (fileMatch) {
    const file = fileMatch[1] === TOKEN && files.get(decodeURIComponent(fileMatch[2]));
    if (!file) return send(res, 404, { ok: false });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(file);
  }

  const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
  if (!match) return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  if (match[1] !== TOKEN) return send(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
  const method = methods[match[2]];
  if (!method) return send(res, 404, { ok: false, error_code: 404, description: `Not Found: method ${match[2]}` });
  try {
    return ok(res, await method(await body(req)));
  } catch (error) {
    return send(res, error.code || 400, { ok: false, error_code: error.code || 400, description: error.message });
  }
}).listen(Number(process.env.PORT) || 8081, () => console.log('fake telegram on :' + (Number(process.env.PORT) || 8081)));
