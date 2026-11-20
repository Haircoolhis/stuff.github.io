// My Music: public listening page, live song selection, sharing switch and group listen.
// No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data.json');
// Song lengths in seconds, so the server can run the group-listen clock by itself.
const DUR = { done: 156.72, dupe: 319.58, dupe2: 353.9, daalu: 307.63, belong: 163.58, carry: 180.98, skies: 202.87, bloom: 177.12, selfish: 182.04, fire: 174.24 };
const SONG_IDS = Object.keys(DUR);

let state = {
  sharing: true,
  songs: (process.env.DEFAULT_SONGS || SONG_IDS.join(',')).split(',').filter(id => SONG_IDS.includes(id)),
  group: { on: false, songId: null, startedAt: 0, paused: true, pausePos: 0 },
  updatedAt: new Date().toISOString()
};
try {
  const s = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (Array.isArray(s.songs)) state = { ...state, ...s, group: { ...state.group, ...(s.group || {}) } };
} catch (e) {}

const now = () => Date.now();
const pos = () => (state.group.paused ? state.group.pausePos : (now() - state.group.startedAt) / 1000);
const shared = () => SONG_IDS.filter(id => state.songs.includes(id));

function neighbour(step) {
  const list = shared();
  if (!list.length) return null;
  const i = list.indexOf(state.group.songId);
  return list[((i < 0 ? (step > 0 ? -1 : 0) : i) + step + list.length) % list.length];
}
function startSong(id, keepPaused) {
  const g = state.group;
  g.songId = id; g.pausePos = 0; g.startedAt = now();
  if (!id) g.paused = true;
  else if (!keepPaused) g.paused = false;
}
function snapshot() { return { ...state, serverNow: now() }; }

const clients = new Set();
function changed() {
  state.updatedAt = new Date().toISOString();
  fs.writeFile(DATA, JSON.stringify(state), () => {});
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (e) {} }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);

// The group-listen clock: moves on to the next shared song when one finishes,
// whether or not anyone (the host included) has the page open.
setInterval(() => {
  const g = state.group;
  if (!g.on || g.paused || !g.songId) return;
  if (!state.sharing) return;
  if (pos() >= (DUR[g.songId] || 0)) { startSong(neighbour(1)); changed(); }
}, 1000);

const TYPES = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg', '.png': 'image/png', '.json': 'application/json' };

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': type.startsWith('audio') ? 'private, max-age=3600' : 'no-cache' };
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
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => { let v = null; try { v = JSON.parse(body || '{}'); } catch (e) {} cb(v); });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());

  if (p === '/api/check' && req.method === 'POST') { res.writeHead(okKey(req.headers['x-admin-key']) ? 204 : 401); return res.end(); }

  // Settings: sharing switch, which songs are shared, group listen on/off.
  if (p === '/api/state' && req.method === 'POST') {
    return readBody(req, b => {
      if (!okKey(req.headers['x-admin-key'])) return json(res, 401, { error: 'wrong password' });
      if (!b) return json(res, 400, { error: 'bad request' });
      if (typeof b.sharing === 'boolean') state.sharing = b.sharing;
      if (Array.isArray(b.songs)) {
        state.songs = SONG_IDS.filter(id => b.songs.includes(id));
        if (state.group.songId && !state.songs.includes(state.group.songId)) startSong(neighbour(1), state.group.paused);
      }
      if (typeof b.group === 'boolean') {
        state.group.on = b.group;
        if (b.group && !state.group.songId) startSong(shared()[0] || null, true);
        if (!b.group) { state.group.pausePos = pos(); state.group.paused = true; }
      }
      changed();
      json(res, 200, snapshot());
    });
  }

  // Group-listen remote control.
  if (p === '/api/control' && req.method === 'POST') {
    return readBody(req, b => {
      if (!okKey(req.headers['x-admin-key'])) return json(res, 401, { error: 'wrong password' });
      const g = state.group, act = b && b.action;
      if (!g.on) return json(res, 409, { error: 'group listen is off' });
      if (act === 'play') { if (!g.songId) startSong(shared()[0] || null); else if (g.paused) { g.startedAt = now() - g.pausePos * 1000; g.paused = false; } }
      else if (act === 'pause') { if (!g.paused) { g.pausePos = pos(); g.paused = true; } }
      else if (act === 'next') startSong(neighbour(1), g.paused);
      else if (act === 'prev') { if (pos() > 5) startSong(g.songId, g.paused); else startSong(neighbour(-1), g.paused); }
      else if (act === 'jump' && state.songs.includes(b.songId)) startSong(b.songId);
      else if (act === 'seek' && typeof b.to === 'number' && g.songId) {
        const to = Math.max(0, Math.min(b.to, DUR[g.songId] - 1));
        if (g.paused) g.pausePos = to; else g.startedAt = now() - to * 1000;
      }
      else return json(res, 400, { error: 'unknown action' });
      changed();
      json(res, 200, snapshot());
    });
  }

  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(PUBLIC, 'index.html'));
  if (p === '/admin') return sendFile(req, res, path.join(PUBLIC, 'admin.html'));
  if (p.startsWith('/songs/')) {
    const f = path.normalize(path.join(PUBLIC, p));
    if (!f.startsWith(path.join(PUBLIC, 'songs'))) { res.writeHead(403); return res.end(); }
    // With sharing switched off, the songs only play for the admin.
    if (!state.sharing && !okKey(url.searchParams.get('k'))) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Sharing is off'); }
    return sendFile(req, res, f);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, () => console.log('My Music listening on ' + PORT));

// Keep the free instance awake: Render sleeps a free web service after 15 minutes
// without inbound traffic, so the app calls its own public address every 10 minutes.
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) setInterval(() => { fetch(SELF + '/healthz').catch(() => {}); }, 10 * 60 * 1000);
