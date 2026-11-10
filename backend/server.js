// OEE Linka: backend (Node.js 18+, bez externých závislostí)
// Štruktúra: backend/server.js + frontend/index.html
// Spustenie: node backend/server.js  →  http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, "users.json");
const INDEX_FILE = path.join(__dirname, "..", "frontend", "index.html");
const SESSION_MS = 8 * 3600 * 1000;
const ROLES = ["Pracovník", "Vedúci"];
// Na Render (HTTPS) sa cookie nastaví ako Secure, lokálne cez http nie
const SECURE = process.env.RENDER ? "; Secure" : "";

// ---------- Dáta OEE (zatiaľ pevné, neskôr nahradiť DB / PLC) ----------
const ERRORS = [
  { code: "ST-038", title: "Svetelný modul kamery prerušil činnosť", when: "10:00–11:00 (hodina 5)",
    steps: ["Skontrolujte napájanie a kábel svetelného modulu.",
            "Vyčistite osvetlenie a objektív kamery.",
            "Reštartujte modul a spustite kontrolu znova. Ak sa chyba opakuje, zavolajte majstra."] },
  { code: "ST-016", title: "Kamerové pracovisko prerušilo činnosť", when: "06:00–07:00 (hodina 1)",
    steps: ["Skontrolujte spojenie a napájanie kamery.",
            "Utrite objektív a skontrolujte nastavenie kamery.",
            "Reštartujte kamerové pracovisko. Ak sa chyba opakuje, zavolajte majstra."] },
  { code: "ST-046", title: "Meracia jednotka tesnosti prerušila skúšku", when: "07:00–08:00 alebo 13:00–14:00 (hodiny 2 a 8)",
    steps: ["Skontrolujte hadice a spoje meracej jednotky (únik vzduchu).",
            "Skontrolujte tesnenie skúšobného lôžka, opotrebované vymeňte.",
            "Spustite skúšku znova na referenčnom kuse. Ak sa chyba opakuje, zavolajte majstra."] }
];
function withMinutes(mins) {
  return ERRORS.map((e, i) => Object.assign({}, e, { minutes: mins[i] }));
}

function kpi(d) {
  const a = (d.plannedMin - d.downtimeMin) / d.plannedMin;
  const p = d.produced / d.idealProduced;
  const q = d.ok / d.produced;
  return Object.assign({}, d, { nok: d.produced - d.ok, availability: a, performance: p, quality: q, oee: a * p * q });
}

function pad(n) { return String(n).padStart(2, "0"); }
const HOURLY_LOSS = [11, 6, 5, 5, 13, 5, 5, 6];   // strata performance v % podľa hodiny zmeny

function todayData() {
  return kpi({
    label: "06:00–14:00",
    startSec: 6 * 3600, endSec: 14 * 3600, shiftMin: 480,
    target: 0.85,
    plannedMin: 440, downtimeMin: 46,
    produced: 392, idealProduced: 394, ok: 388,
    topErrors: withMinutes([18, 12, 8]),
    hourly: HOURLY_LOSS.map((loss, i) => ({
      hour: i + 1,
      label: pad(6 + i) + ":00–" + pad(7 + i) + ":00",
      loss: loss,
      critical: loss >= 10
    })),
    note: "Denné hodnoty sú ilustračné demo údaje. Plánovaný čas = 480 min − 40 min obed = 440 min; " +
          "prestoje 46 min = top 3 poruchy (18 + 12 + 8 = 38 min) + ostatné poruchy " +
          "(odhad 8 min z mesačného priemeru ST-047, ST-001, ST-017)."
  });
}

function monthData() {
  return kpi({
    shiftsCount: 21,
    plannedMin: 9240, downtimeMin: 410,
    produced: 8251, idealProduced: 8830, ok: 8132,
    topErrors: withMinutes([100, 70, 70])
  });
}

// ---------- Heslá a účty ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return salt.toString("hex") + ":" + h.toString("hex");
}
function checkPw(pw, stored) {
  const [s, h] = stored.split(":");
  const calc = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
  const real = Buffer.from(h, "hex");
  return calc.length === real.length && crypto.timingSafeEqual(calc, real);
}
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch (e) {
    // Heslá demo účtov sa dajú nastaviť cez premenné prostredia BOSS_PASSWORD a WORKER_PASSWORD
    const bossPw = process.env.BOSS_PASSWORD || "boss";
    const workerPw = process.env.WORKER_PASSWORD || "worker";
    if (!process.env.BOSS_PASSWORD || !process.env.WORKER_PASSWORD)
      console.warn("Používajú sa predvolené heslá boss/worker. Nastavte BOSS_PASSWORD a WORKER_PASSWORD!");
    const seed = [
      { u: "boss", h: hashPw(bossPw), r: "Vedúci" },
      { u: "worker", h: hashPw(workerPw), r: "Pracovník" }
    ];
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2)); } catch (err) {}
    return seed;
  }
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.error("Nepodarilo sa uložiť users.json:", e.message); }
}

const users = loadUsers();
const sessions = new Map();   // token -> { u, r, exp }
const loginLog = [];          // { u, r, t }
const attempts = new Map();   // ip -> { n, t }

// ---------- Pomocné funkcie ----------
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 10240) { reject(new Error("big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("json")); }
    });
  });
}
function getSession(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return Object.assign({ token: m[1] }, s);
}
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (process.env.RENDER && xff) return xff.split(",").pop().trim();
  return req.socket.remoteAddress;
}
function tooMany(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.t > 600000) { attempts.set(ip, { n: 0, t: now }); return false; }
  return a.n >= 10;
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const ip = clientIp(req);

  try {
    // Frontend
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }

    // Prihlásenie
    if (req.method === "POST" && url === "/api/login") {
      if (tooMany(ip)) return send(res, 429, { error: "Príliš veľa pokusov. Skúste neskôr." });
      const b = await readBody(req);
      const user = users.find(x => x.u === String(b.u || "").trim());
      if (!user || !checkPw(String(b.p || ""), user.h)) {
        attempts.get(ip).n++;
        return send(res, 401, { error: "Nesprávne meno alebo heslo." });
      }
      attempts.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { u: user.u, r: user.r, exp: Date.now() + SESSION_MS });
      loginLog.unshift({ u: user.u, r: user.r, t: new Date().toISOString() });
      if (loginLog.length > 100) loginLog.pop();
      return send(res, 200, { u: user.u, r: user.r }, {
        "Set-Cookie": "sid=" + token + "; HttpOnly" + SECURE + "; SameSite=Strict; Path=/; Max-Age=" + SESSION_MS / 1000
      });
    }

    // Odhlásenie
    if (req.method === "POST" && url === "/api/logout") {
      const s = getSession(req);
      if (s) sessions.delete(s.token);
      return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly" + SECURE + "; SameSite=Strict; Path=/; Max-Age=0" });
    }

    // Všetko nižšie vyžaduje prihlásenie
    const s = getSession(req);
    if (!s) return send(res, 401, { error: "Neprihlásený." });

    if (req.method === "GET" && url === "/api/me") return send(res, 200, { u: s.u, r: s.r });

    // Dnešný prehľad: vidí pracovník aj vedúci
    if (req.method === "GET" && url === "/api/today") return send(res, 200, todayData());

    // Mesačný prehľad a správa účtov: iba vedúci
    if (url === "/api/month" || url === "/api/users" || url === "/api/logins") {
      if (s.r !== "Vedúci") return send(res, 403, { error: "Nedostatočné oprávnenie." });

      if (req.method === "GET" && url === "/api/month") return send(res, 200, monthData());
      if (req.method === "GET" && url === "/api/users")
        return send(res, 200, users.map(x => ({ u: x.u, r: x.r })));
      if (req.method === "GET" && url === "/api/logins") return send(res, 200, loginLog);

      if (req.method === "POST" && url === "/api/users") {
        const b = await readBody(req);
        const u = String(b.u || "").trim(), p = String(b.p || ""), r = String(b.r || "");
        if (u.length < 3 || u.length > 32) return send(res, 400, { error: "Meno musí mať 3 až 32 znakov." });
        if (p.length < 8) return send(res, 400, { error: "Heslo musí mať aspoň 8 znakov." });
        if (ROLES.indexOf(r) < 0) return send(res, 400, { error: "Neplatná rola." });
        if (users.some(x => x.u.toLowerCase() === u.toLowerCase()))
          return send(res, 409, { error: "Takéto meno už existuje." });
        users.push({ u: u, h: hashPw(p), r: r });
        saveUsers();
        return send(res, 201, { u: u, r: r });
      }
    }

    send(res, 404, { error: "Nenájdené." });
  } catch (e) {
    if (e.message === "json") return send(res, 400, { error: "Neplatný JSON." });
    if (e.message === "big") return send(res, 413, { error: "Príliš veľká požiadavka." });
    console.error(e);
    send(res, 500, { error: "Chyba servera." });
  }
});

server.listen(PORT, () => console.log("OEE Linka beží na http://localhost:" + PORT));
