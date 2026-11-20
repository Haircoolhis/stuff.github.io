// My Music: public listening page + live song selection, no dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data.json');
const SONG_IDS = ['done', 'dupe', 'dupe2'];

let state = { songs: (process.env.DEFAULT_SONGS || SONG_IDS.join(',')).split(',').filter(id => SONG_IDS.includes(id)), updatedAt: new Date().toISOString() };
try { const s = JSON.parse(fs.readFileSync(DATA, 'utf8')); if (Array.isArray(s.songs)) state = s; } catch (e) {}

const clients = new Set();
function broadcast() {
  const msg = 'data: ' + JSON.stringify(state) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (e) {} }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);

const TYPES = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': type.startsWith('audio') ? 'public, max-age=86400' : 'no-cache' };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
      if (start < 0) start = 0;
      if (start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function okKey(key) {
  if (!ADMIN || typeof key !== 'string') return false;
  const a = crypto.createHash('sha256').update(key).digest();
  const b = crypto.createHash('sha256').update(ADMIN).digest();
  return crypto.timingSafeEqual(a, b);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (p === '/api/songs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state));
  }

  if (p === '/api/songs' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      if (!okKey(req.headers['x-admin-key'])) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"wrong password"}'); }
      let songs;
      try { songs = JSON.parse(body).songs; } catch (e) {}
      if (!Array.isArray(songs)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad request"}'); }
      state = { songs: SONG_IDS.filter(id => songs.includes(id)), updatedAt: new Date().toISOString() };
      fs.writeFile(DATA, JSON.stringify(state), () => {});
      broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    });
    return;
  }

  if (p === '/api/check' && req.method === 'POST') {
    res.writeHead(okKey(req.headers['x-admin-key']) ? 204 : 401); return res.end();
  }

  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\ndata: ' + JSON.stringify(state) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(PUBLIC, 'index.html'));
  if (p === '/admin') return sendFile(req, res, path.join(PUBLIC, 'admin.html'));
  if (p.startsWith('/songs/')) {
    const f = path.normalize(path.join(PUBLIC, p));
    if (!f.startsWith(path.join(PUBLIC, 'songs'))) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, f);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, () => console.log('My Music listening on ' + PORT));

// Keep the free instance awake: Render sleeps a free web service after 15 minutes
// without inbound traffic, so the app calls its own public address every 10 minutes.
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) setInterval(() => { fetch(SELF + '/healthz').catch(() => {}); }, 10 * 60 * 1000);
