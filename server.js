const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.log');
const LAST_DIGEST_FILE = path.join(DATA_DIR, 'last-digest.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function proxyApi(targetUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ---------- Bug reports ---------- */

const MAX_REPORT_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const reportHits = new Map();

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = reportHits.get(ip);
  if (!rec || now > rec.reset) {
    reportHits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  if (rec.count >= RATE_MAX) return true;
  rec.count++;
  return false;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => tooLarge ? reject(new Error('TOO_LARGE')) : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cleanLine(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

function formatReport(r) {
  return [
    '<<<REPORT>>>',
    'id=' + cleanLine(r.id, 64),
    'time=' + cleanLine(r.time, 40),
    'version=' + cleanLine(r.version, 24),
    'lang=' + cleanLine(r.lang, 10),
    'theme=' + cleanLine(r.theme, 10),
    'page=' + cleanLine(r.page, 200),
    'contact=' + cleanLine(r.contact, 120),
    'subject=' + cleanLine(r.subject, 160),
    'body=' + JSON.stringify(cleanText(r.body, 4000)),
    'ua=' + cleanLine(r.ua, 300),
    '<<<END>>>',
    ''
  ].join('\n');
}

function saveReport(report) {
  fs.appendFileSync(REPORTS_FILE, formatReport(report), 'utf8');
}

function readReports() {
  let raw = '';
  try { raw = fs.readFileSync(REPORTS_FILE, 'utf8'); } catch (e) { return []; }
  return raw.split('<<<REPORT>>>').slice(1).map(block => {
    const end = block.indexOf('<<<END>>>');
    const part = end === -1 ? block : block.slice(0, end);
    const obj = {};
    part.split('\n').forEach(line => {
      const i = line.indexOf('=');
      if (i > 0) obj[line.slice(0, i)] = line.slice(i + 1);
    });
    if (obj.body) {
      try { obj.body = JSON.parse(obj.body); } catch (e) { /* keep raw */ }
    }
    return obj;
  }).filter(r => r.time);
}

/* ---------- Weekly email digest ---------- */

function smtpConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS && (process.env.REPORT_TO || process.env.SMTP_USER));
}

function stripHeader(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, '');
}

function encodeSubject(value) {
  return /[^\x20-\x7E]/.test(value)
    ? '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?='
    : value;
}

function buildMessage(subject, text, from, to) {
  const body = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n')
    .replace(/^\./gm, '..');
  return [
    'From: ' + stripHeader(from),
    'To: ' + stripHeader(to),
    'Subject: ' + encodeSubject(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + Date.now() + '-' + Math.random().toString(36).slice(2) + '@buscador-srn>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ].join('\r\n');
}

function sendMail(subject, text) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;
    const to = process.env.REPORT_TO || user;

    if (!user || !pass || !to) return reject(new Error('Faltan SMTP_USER, SMTP_PASS o REPORT_TO'));
    if (port !== 465) return reject(new Error('Usa SMTP_PORT=465 (TLS implícito)'));

    const socket = tls.connect({ host, port, servername: host });
    let buffer = '';
    let step = 0;
    let finished = false;
    const timer = setTimeout(() => fail(new Error('Timeout SMTP')), 30000);

    function fail(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }

    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.end();
      resolve();
    }

    function write(line) {
      socket.write(line + '\r\n');
    }

    const steps = [
      { code: '220', send: () => 'EHLO localhost' },
      { code: '250', send: () => 'AUTH PLAIN ' + Buffer.from('\0' + user + '\0' + pass, 'utf8').toString('base64') },
      { code: '235', send: () => 'MAIL FROM:<' + stripHeader(from) + '>' },
      { code: '250', send: () => 'RCPT TO:<' + stripHeader(to) + '>' },
      { code: ['250', '251'], send: () => 'DATA' },
      { code: '354', send: () => buildMessage(subject, text, from, to) + '\r\n.' },
      { code: '250', send: () => 'QUIT' },
      { code: '221', send: () => null }
    ];

    function handleLine(line) {
      if (step >= steps.length) return;
      const expected = steps[step].code;
      const codes = Array.isArray(expected) ? expected : [expected];
      const code = line.slice(0, 3);
      if (!codes.includes(code)) {
        if (/^[45]/.test(code)) fail(new Error('SMTP ' + line));
        return;
      }
      if (line.length > 3 && line[3] === '-') return;
      if (line.length > 3 && line[3] !== ' ') return;
      const next = steps[step].send();
      step++;
      if (next === null) return done();
      write(next);
    }

    socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.on('data', chunk => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1 && !finished) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleLine(line);
      }
    });
  });
}

function getLastDigest() {
  try {
    const d = new Date(fs.readFileSync(LAST_DIGEST_FILE, 'utf8').trim());
    return isNaN(d.getTime()) ? new Date(0) : d;
  } catch (e) {
    return new Date(0);
  }
}

function setLastDigest(date) {
  fs.writeFileSync(LAST_DIGEST_FILE, date.toISOString(), 'utf8');
}

function monday9(base, offsetWeeks) {
  const d = new Date(base);
  d.setHours(9, 0, 0, 0);
  const daysUntilMonday = (1 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysUntilMonday + offsetWeeks * 7);
  return d;
}

function nextMonday9(now) {
  const target = monday9(now, 0);
  return target > now ? target : monday9(now, 1);
}

function buildDigestText(reports) {
  const lines = ['Se recibieron ' + reports.length + ' reporte(s) desde el último resumen.', ''];
  reports.forEach((r, i) => {
    lines.push('#' + (i + 1) + ' [' + r.time + '] ' + (r.subject || '(sin asunto)'));
    lines.push('  version=' + (r.version || '-') + ' | lang=' + (r.lang || '-') + ' | theme=' + (r.theme || '-') + ' | page=' + (r.page || '-'));
    if (r.contact) lines.push('  contacto=' + r.contact);
    lines.push(String(r.body || '').split('\n').map(l => '  ' + l).join('\n'));
    lines.push('');
  });
  let text = lines.join('\n');
  if (text.length > 45000) text = text.slice(0, 45000) + '\n\n(resumen truncado; revisa data/reports.log)';
  return text;
}

async function runDigest() {
  try {
    const now = new Date();
    const target = monday9(now, 0);
    const last = getLastDigest();
    if (last >= target) return scheduleNextDigest();

    const pending = readReports().filter(r => {
      const t = new Date(r.time);
      return !isNaN(t.getTime()) && t > last;
    });

    if (!pending.length) {
      setLastDigest(now);
      return scheduleNextDigest();
    }

    await sendMail(
      'Buscador SRN - resumen semanal de errores (' + pending.length + ')',
      buildDigestText(pending)
    );
    setLastDigest(now);
    console.log('  Resumen semanal enviado (' + pending.length + ' reporte(s))\n');
    return scheduleNextDigest();
  } catch (err) {
    console.error('  No se pudo enviar el resumen:', err.message);
    return setTimeout(runDigest, 60 * 60 * 1000);
  }
}

function scheduleNextDigest() {
  if (!smtpConfigured()) {
    console.log('  Resumen semanal desactivado: configura SMTP_USER, SMTP_PASS y REPORT_TO.\n');
    return;
  }
  const now = new Date();
  const next = nextMonday9(now);
  setTimeout(runDigest, next - now);
  console.log('  Próximo resumen semanal: ' + next.toString() + '\n');
}

/* ---------- Server ---------- */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (parsed.pathname === '/api/proxy') {
    const target = parsed.searchParams.get('url');
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing url parameter' }));
    }

    const allowed = ['ec.europa.eu', 'api.datalake.sante.service.ec.europa.eu'];
    try {
      const host = new URL(target).hostname;
      if (!allowed.includes(host)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Domain not allowed' }));
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid URL' }));
    }

    try {
      const result = await proxyApi(target);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/api/report') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many reports' }));
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req, MAX_REPORT_BYTES));
    } catch (err) {
      const tooLarge = err.message === 'TOO_LARGE';
      res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: tooLarge ? 'Report too large' : 'Invalid JSON' }));
    }

    const subject = cleanLine(payload.subject, 160);
    const details = cleanText(payload.details, 4000);
    if (!subject || !details) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing subject or details' }));
    }

    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
    try {
      saveReport({
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        time: new Date().toISOString(),
        version: meta.version,
        lang: meta.lang,
        theme: meta.theme,
        page: meta.page,
        contact: payload.contact,
        subject: subject,
        body: details,
        ua: meta.ua
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not save report' }));
    }
    return;
  }

  if (parsed.pathname === '/data' || parsed.pathname.startsWith('/data/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  let filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  Buscador SRN corriendo en: http://localhost:${PORT}\n`);
  scheduleNextDigest();
});
