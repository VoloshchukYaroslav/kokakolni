// OEE Improvement Engine: server (Node 18+, no dependencies)
// Run:  node server.js   ->  http://localhost:3000
//
// Serves:
//   /                 public/index.html
//   /<file>           files from public/ (app.js, style.css, vendor/...)
//   /model/<file>     3D models from model/ (if the folder exists)
//   /api/data         data/data.json (built by tools/xlsx_to_json.py)
//   /api/config       { view: "3d" | "2d", ai: true | false }
//   POST /api/fix     Claude-written fix for one finding. The API key stays here, read from .env.
//
// The browser never sees the key and never sends a prompt: it sends what the finding is about
// (code / topic) and the replay moment "asOf". The server builds the prompt from data.json,
// using only events that started before asOf, so Claude cannot see the future either.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

// ---------- .env (KEY=value lines; real environment variables win) ----------
(function loadEnv() {
  const file = path.join(ROOT, ".env");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, "public");
const MODEL_DIR = path.join(ROOT, "model");
const MODEL_FILE = path.join(MODEL_DIR, "line_L01_stations.glb");
const DATA_FILE = path.join(ROOT, "data", "data.json");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Resolve a URL path inside a base folder. Returns null if it tries to escape.
function safeJoin(base, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return null; }
  const full = path.resolve(base, "." + path.sep + rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { if (!over) { over = true; reject(new Error("too big")); } return; }   // keep draining, answer 400
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

// ---------- data for the fix prompt ----------
let DATA = null;
function data() {
  if (!DATA) DATA = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return DATA;
}
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = (date) => new Date(date + "T00:00:00Z").getUTCDay();

// Facts about one topic, from events that started strictly before asOf ("YYYY-MM-DDTHH:MM").
function factsFor(body) {
  const D = data();
  const asOf = String(body.asOf || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(asOf)) return { error: "asOf must be YYYY-MM-DDTHH:MM" };
  const past = (iso) => iso < asOf;                       // ISO strings of the same format compare as time
  const topic = String(body.topic || "");

  if (topic === "code") {
    const code = String(body.code || "");
    const def = D.codes.find((c) => c.code === code);
    if (!def) return { error: "Unknown code" };
    const downs = D.downtimes.filter((d) => d.code === code && past(d.from));
    // a defect is only known once its hour is over (the xlsx gives defects per hour, not per minute)
    const hourTo = new Map(D.hours.map((h) => [h.id, h.to]));
    const noks = D.nok.filter((n) => n.code === code && hourTo.has(n.hour_id) && past(hourTo.get(n.hour_id)));
    if (!downs.length && !noks.length) return { error: "No past events for this code yet" };
    // a stop still running at asOf: its end and length are the future, so they are not sent
    const lines = downs.map((d) => `${d.date} (${WD[weekdayOf(d.date)]}) ${d.from.slice(11)}` +
      (past(d.to) ? `–${d.to.slice(11)}, ${d.min} min` : ", still stopped at the end of the data"));
    const doneMin = downs.filter((d) => past(d.to)).reduce((s, d) => s + d.min, 0);
    const nokQty = noks.reduce((s, n) => s + n.qty, 0);
    return {
      text:
        `Line L01, e-drive assembly, one 8 h shift 06:00–14:00, ideal cycle 60 s, OEE target 85%.\n` +
        `Code ${code} (${def.type === "Kvalita" ? "defect" : "stop"}): ${def.en}. Equipment: ${(downs[0] || noks[0] || {}).equipment || def.category}.\n` +
        (downs.length ? `Past stops (${downs.length}, ${doneMin} min in the finished ones):\n- ${lines.join("\n- ")}\n` : "") +
        (noks.length ? `Past defect parts with this code: ${nokQty} pcs.\n` : "") +
        `Data ends at ${asOf.replace("T", " ")}; nothing after that is known.`,
    };
  }
  if (topic === "restart") {
    const hours = D.hours.filter((h) => past(h.to));
    if (!hours.length) return { error: "No finished hours yet" };
    const by = {};
    for (const h of hours) {
      const b = (by[h.hour] = by[h.hour] || { run: 0, prod: 0, pause: 0 });
      b.run += h.run_min; b.prod += h.produced; b.pause += (h.am_min || 0) + (h.pause_min || 0);
    }
    const rows = Object.keys(by).map((k) => `hour ${k}: performance ${(by[k].prod / by[k].run * 100).toFixed(1)}%${by[k].pause ? " (has planned pause)" : ""}`);
    return {
      text:
        `Line L01, e-drive assembly, shift 06:00–14:00, ideal cycle 60 s. Planned pauses: hour 1 has 10 min autonomous maintenance, hour 5 has a 30 min break.\n` +
        `Performance by shift hour, all past shifts:\n- ${rows.join("\n- ")}\n` +
        `Compare the hours with and without a planned pause. Data ends at ${asOf.replace("T", " ")}.`,
    };
  }
  return { error: "Unknown topic" };
}

// ---------- Claude call ----------
const fixCache = new Map();          // key -> { steps, why }
const inFlight = new Map();          // key -> Promise
let callsThisHour = 0, hourStart = Date.now();

async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 600,
      system:
        "You help operators and the shift leader on an assembly line. Answer in English, plain words, no jargon. " +
        "Return only JSON: {\"why\": one sentence with the most likely cause, \"steps\": 3 to 5 short imperative steps an operator or maintenance tech can do}. " +
        "Base the cause on the timing pattern in the data. Do not invent measurements that are not in the data.",
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Claude API HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}`);
  }
  const j = await res.json();
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const steps = Array.isArray(o.steps) ? o.steps.map(String).filter(Boolean).slice(0, 6) : [];
      if (steps.length) return { why: String(o.why || ""), steps };
    } catch (e) { /* fall through */ }
  }
  const steps = text.split(/\n+/).map((s) => s.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean).slice(0, 6);
  return { why: "", steps };
}

async function handleFix(req, res) {
  // same-origin only: a page on another site cannot spend the key
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJson(res, 403, { error: "Cross-origin" });
  if (!API_KEY) return sendJson(res, 503, { error: "No ANTHROPIC_API_KEY in .env", ai: false });
  let body;
  try { body = await readBody(req, 2048); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  let f;
  try { f = factsFor(body); } catch (e) { return sendJson(res, 500, { error: "data.json: " + e.message }); }
  if (f.error) return sendJson(res, 400, { error: f.error });
  f.key = f.text.split("Data ends at")[0];   // same facts -> same answer, whatever minute it is asked
  if (fixCache.has(f.key)) return sendJson(res, 200, { ...fixCache.get(f.key), cached: true });

  if (Date.now() - hourStart > 3600e3) { hourStart = Date.now(); callsThisHour = 0; }
  if (!inFlight.has(f.key) && callsThisHour >= 60) return sendJson(res, 429, { error: "Hourly limit reached" });

  let p = inFlight.get(f.key);
  if (!p) {
    callsThisHour++;
    p = askClaude(f.text).finally(() => inFlight.delete(f.key));
    inFlight.set(f.key, p);
  }
  try {
    const out = await p;
    if (fixCache.size > 500) fixCache.clear();
    fixCache.set(f.key, out);
    sendJson(res, 200, out);
  } catch (e) {
    console.error("fix:", e.message);
    sendJson(res, 502, { error: e.name === "TimeoutError" ? "Claude did not answer in 30 s" : "Claude API error" });
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/fix") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    return void handleFix(req, res);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });

  if (url === "/api/data") return sendFile(res, DATA_FILE);
  if (url === "/api/config") return sendJson(res, 200, { view: fs.existsSync(MODEL_FILE) ? "3d" : "2d", ai: !!API_KEY });

  if (url.startsWith("/model/")) {
    const f = safeJoin(MODEL_DIR, url.slice("/model/".length));
    return f ? sendFile(res, f) : sendJson(res, 400, { error: "Bad path" });
  }

  const f = safeJoin(PUBLIC_DIR, url === "/" ? "index.html" : url.slice(1));
  return f ? sendFile(res, f) : sendJson(res, 400, { error: "Bad path" });
});

server.listen(PORT, () => {
  console.log("OEE Improvement Engine: http://localhost:" + PORT);
  console.log("View: " + (fs.existsSync(MODEL_FILE) ? "3D" : "2D (no model/line_L01_stations.glb)") +
    " · AI fixes: " + (API_KEY ? "on (" + AI_MODEL + ")" : "off, add ANTHROPIC_API_KEY to .env"));
  if (!fs.existsSync(DATA_FILE)) console.warn("WARNING: data/data.json missing. Run tools/xlsx_to_json.py first.");
});
