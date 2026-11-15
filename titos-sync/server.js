// Tiny sync server for Tito's Maths: one progress record, protected by a family code.
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;
const FAMILY_CODE = process.env.FAMILY_CODE || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://titos-maths.onrender.com").split(",").map(s => s.trim());
const DB_URL = process.env.DATABASE_URL || "";
const MAX_BODY = 512 * 1024;

let pool = null, ready = false, lastError = "";
if (DB_URL) {
  const external = /render\.com/.test(DB_URL);
  pool = new Pool({ connectionString: DB_URL, ssl: external ? { rejectUnauthorized: false } : false, max: 3 });
  pool.query(`CREATE TABLE IF NOT EXISTS tito_maths_progress (
      id TEXT PRIMARY KEY, json TEXT NOT NULL, updated BIGINT NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => { ready = true; console.log("Database ready"); })
    .catch(e => { lastError = e.message; console.error("Database setup failed:", e.message); });
}

function codeOk(given) {
  if (!FAMILY_CODE || !given) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(FAMILY_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}
function send(res, status, obj, origin) {
  const h = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin && ORIGINS.includes(origin)) { h["access-control-allow-origin"] = origin; h["vary"] = "Origin"; }
  res.writeHead(status, h); res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") {
    const h = { "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "content-type,x-family-code", "access-control-max-age": "86400" };
    if (origin && ORIGINS.includes(origin)) { h["access-control-allow-origin"] = origin; h["vary"] = "Origin"; }
    res.writeHead(204, h); return res.end();
  }
  if (url.pathname === "/health") return send(res, 200, { ok: true, db: ready, configured: !!DB_URL && !!FAMILY_CODE, error: ready ? undefined : lastError || undefined }, origin);
  if (url.pathname !== "/api/progress") return send(res, 404, { error: "not found" }, origin);
  if (!codeOk(req.headers["x-family-code"])) return send(res, 401, { error: "wrong family code" }, origin);
  if (!ready) return send(res, 503, { error: "database not ready" }, origin);

  try {
    if (req.method === "GET") {
      const r = await pool.query("SELECT json, updated FROM tito_maths_progress WHERE id='tito'");
      return send(res, 200, r.rows[0] ? { json: r.rows[0].json, updated: Number(r.rows[0].updated) } : { json: null, updated: 0 }, origin);
    }
    if (req.method === "PUT") {
      let body = "", size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return send(res, 413, { error: "too large" }, origin); body += chunk; }
      let data; try { data = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }, origin); }
      const updated = Number(data.updated);
      if (typeof data.json !== "string" || !Number.isFinite(updated)) return send(res, 400, { error: "bad body" }, origin);
      try { JSON.parse(data.json); } catch { return send(res, 400, { error: "bad progress" }, origin); }
      // Only accept newer progress; otherwise hand back what we have.
      const r = await pool.query(
        `INSERT INTO tito_maths_progress (id, json, updated) VALUES ('tito', $1, $2)
         ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, updated = EXCLUDED.updated, saved_at = now()
         WHERE tito_maths_progress.updated < EXCLUDED.updated
         RETURNING updated`, [data.json, updated]);
      if (r.rowCount) return send(res, 200, { ok: true, updated }, origin);
      const cur = await pool.query("SELECT json, updated FROM tito_maths_progress WHERE id='tito'");
      return send(res, 409, { json: cur.rows[0].json, updated: Number(cur.rows[0].updated) }, origin);
    }
    return send(res, 405, { error: "method not allowed" }, origin);
  } catch (e) {
    console.error(e.message); return send(res, 500, { error: "server error" }, origin);
  }
}).listen(PORT, () => console.log("Tito sync listening on", PORT));
