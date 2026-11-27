const express = require('express');
const http = require('http');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const IDLE_MS = Number(process.env.IDLE_MS) || 5 * 60 * 1000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 20;
const VIEW = { width: 1280, height: 800 };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/session' });
const sessions = new Set();
let browser;

// חסימת כתובות פנימיות, כדי שהגולש לא יגיע לרשת הפנימית של השרת
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') ||
      l.startsWith('fe80') || l.startsWith('::ffff:');
  }
  return true;
}

async function isAllowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  try {
    const { address } = await dns.lookup(url.hostname);
    return !isPrivateAddress(address);
  } catch { return false; }
}

// בודק כל בקשה שהדפדפן שולח, כולל הפניות ותמונות
async function guard(route) {
  if (await isAllowedUrl(route.request().url())) return route.continue();
  return route.abort('blockedbyclient');
}

async function openSession(ws) {
  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', message: 'השירות עמוס כרגע, נסו שוב מאוחר יותר' }));
    return ws.close();
  }

  const context = await browser.newContext({ viewport: VIEW, acceptDownloads: false, serviceWorkers: 'block' });
  await context.route('**/*', guard);
  const page = await context.newPage();
  // חלונות קופצים נסגרים, כדי לשמור על חלון אחד לכל גולש
  context.on('page', p => { if (p !== page) p.close().catch(() => {}); });

  const session = { ws, context };
  sessions.add(session);

  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(), IDLE_MS);
  };
  resetIdle();

  const sendFrame = async () => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 60 });
      ws.send(JSON.stringify({ type: 'frame', image: jpeg.toString('base64'), url: page.url() }));
    } catch { /* הדף עסוק או נסגר */ }
  };
  page.on('load', sendFrame);

  ws.on('message', async raw => {
    resetIdle();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.type) {
        case 'navigate':
          if (!(await isAllowedUrl(msg.url))) {
            return ws.send(JSON.stringify({ type: 'error', message: 'הכתובת הזאת חסומה' }));
          }
          await page.goto(msg.url, { timeout: 20000, waitUntil: 'domcontentloaded' });
          break;
        case 'click':
          await page.mouse.click(Number(msg.x), Number(msg.y));
          break;
        case 'type':
          await page.keyboard.type(String(msg.text).slice(0, 200));
          break;
        case 'key':
          await page.keyboard.press(String(msg.key).slice(0, 20));
          break;
        case 'scroll':
          await page.mouse.wheel(0, Math.max(-1000, Math.min(1000, Number(msg.dy) || 0)));
          break;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'הפעולה לא הצליחה' }));
    }
    await sendFrame();
  });

  ws.on('close', async () => {
    clearTimeout(idleTimer);
    sessions.delete(session);
    await context.close().catch(() => {});
  });
}

wss.on('connection', ws => {
  openSession(ws).catch(() => ws.close());
});

async function start() {
  browser = await chromium.launch({ headless: true });
  server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

const shutdown = async () => {
  for (const s of sessions) s.ws.close();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
