// OEE Improvement Engine: prototype server (Node 18+, no dependencies)
// Run:  node server.js   ->  http://localhost:3000
//
// Serves:
//   /                 public/index.html
//   /<file>           files from public/ (app.js, style.css, vendor/...)
//   /model/<file>     3D models from model/
//   /api/data         data/data.json (built by tools/xlsx_to_json.py)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MODEL_DIR = path.join(ROOT, "model");
const DATA_FILE = path.join(ROOT, "data", "data.json");

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

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
  const url = req.url.split("?")[0];

  if (url === "/api/data") return sendFile(res, DATA_FILE);

  if (url.startsWith("/model/")) {
    const f = safeJoin(MODEL_DIR, url.slice("/model/".length));
    return f ? sendFile(res, f) : sendJson(res, 400, { error: "Bad path" });
  }

  const f = safeJoin(PUBLIC_DIR, url === "/" ? "index.html" : url.slice(1));
  return f ? sendFile(res, f) : sendJson(res, 400, { error: "Bad path" });
});

server.listen(PORT, () => {
  console.log("OEE Improvement Engine: http://localhost:" + PORT);
  if (!fs.existsSync(DATA_FILE)) console.warn("WARNING: data/data.json missing. Run tools/xlsx_to_json.py first.");
});
