// OEE Improvement Engine · line L01
// Data: /api/data (built from the xlsx). View: 3D (model/line_L01_stations.glb) or 2D schematic.
// /api/config decides the view: 3D when the server has the model, else 2D. ?view=2d or ?view=3d overrides.
//
// Rule for everything that is counted or searched: only the past. "Now" is the replay moment.
// A stop is known once it has started; a defect once its hour is over (the xlsx gives defects per hour);
// totals per minute come from each hour's totals spread over its running minutes.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ============================================================ constants
const MODEL_URL = "/model/line_L01_stations.glb";
const SHIFT_START_S = 6 * 3600;           // 06:00
const SHIFT_LEN_S = 8 * 3600;             // 8 h
const BLOCK_HOLD_S = 215 / 24;            // blocked stations wait at frame 215
// Camera: a fixed offset from the point it looks at (direction only: the camera is orthographic),
// framing one section of the line; it moves only along the line (X). Change the offset to change the angle.
const CAMERA_OFFSET = new THREE.Vector3(6, 4, 12);
const SECTION_STATIONS = 4;               // stations in view at the default zoom
const BG_HEX = 0xeceef1;
const PATTERN_MIN_HITS = 2;               // a repeat needs at least 2 past hits ...
const PATTERN_MIN_SHARE = 0.75;           // ... on >= 75% of the past same weekdays at that time
const PATTERN_CONFIRMED = 3;              // 3+ hits: "confirmed", 2 hits: "watch"
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// stations in process order: model name, stage label, monitored code
const STATIONS = [
  ["Lift_In", "IN", null], ["ST-001", "1", "ST-001"], ["Station_02", "2", null], ["ST-016", "3", "ST-016"],
  ["Station_04", "4", null], ["ST-017", "5", "ST-017"], ["Station_06", "6", null], ["Station_07", "7", null],
  ["ST-038", "7.5", "ST-038"], ["Station_08", "8", null], ["ST-046", "9a", "ST-046"], ["ST-047", "9b", "ST-047"],
  ["Station_10", "10", null], ["Lift_Out", "OUT", null],
];
// names: short on the floor (tags, lists), long on the "Line stopped" card and station panel
const STATION_SHORT = {
  "Lift_In": "Lift in", "ST-001": "Load", "Station_02": "Motor in", "ST-016": "Camera 1", "Station_04": "Screws 1",
  "ST-017": "Screws 2", "Station_06": "Turn", "Station_07": "Inverter in", "ST-038": "Camera 2", "Station_08": "Inv. screws",
  "ST-046": "Leak test A", "ST-047": "Leak test B", "Station_10": "To EOL", "Lift_Out": "Lift out",
};
const STATION_LONG = {
  "Lift_In": "Pallet lift in", "ST-001": "Housing load", "Station_02": "Motor insertion", "ST-016": "Camera 1 · motor",
  "Station_04": "Motor screws 1", "ST-017": "Motor screws 2", "Station_06": "Turn 90°", "Station_07": "Inverter insertion",
  "ST-038": "Camera 2", "Station_08": "Inverter screws", "ST-046": "Leak test A", "ST-047": "Leak test B",
  "Station_10": "Transfer to EOL", "Lift_Out": "Pallet lift out",
};
const shortName = (n) => STATION_SHORT[n] || n;
const longName = (n) => STATION_LONG[n] || n;

// defect categories in plain words (xlsx has "Slovak / English")
const DEFECT_SHORT = { "Test tesnosti / Leak test": "Leaks", "Lisovanie / Pressing": "Press-fit", "Skrutkovanie / Screwdriving": "Screws", "Kamera / Camera": "Camera check" };
const DEFECT_ISSUE = { "Test tesnosti / Leak test": "Leaks found at test", "Lisovanie / Pressing": "Press-fit short", "Skrutkovanie / Screwdriving": "Screw faults", "Kamera / Camera": "Camera rejects" };

// Rule-based fixes: shown when Claude is off or does not answer.
const FIX = {
  "ST-038": ["Check power and connector of the camera light module.", "Clean the light and the lens.", "Before the next expected slot, swap the light module and run one test part."],
  "ST-047": ["Inspect the test-bed seal; replace it if worn.", "Run the leak self-test with the reference part at shift start.", "Plan seal checks the shift before the expected slot."],
  "ST-046": ["Check hoses and fittings of the leak unit for air loss.", "Check the test-bed seal; replace a worn one.", "Re-run the test on the reference part."],
  "ST-016": ["Check camera cable and power.", "Clean the lens and check the camera settings.", "Restart the camera station; call the shift leader if it repeats."],
  "ST-001": ["Check that housings are staged at the station.", "Trigger housing supply 10 min before the hour.", "Call logistics if the buffer is empty twice in a shift."],
  "ST-017": ["Read the error on the screwdriver controller screen.", "Check the bit. Worn or broken: replace it.", "Reset the sequence and run one test part."],
  "Q-031": ["Check the leak-test seal and fixture.", "Retest suspect parts on the reference setup.", "Log which hour the leaks come in to find the trigger."],
  "Q-020": ["Check press force and stroke settings.", "Inspect the press-fit tooling for wear.", "Measure the first part after every tool change."],
  "Q-026": ["Check bit wear and torque settings.", "Check screw feed for wrong or damaged screws.", "Run one test part after every bit change."],
  "Q-030": ["Clean the camera lens and light.", "Check the camera reference image.", "Re-check rejected parts by hand to find false rejects."],
  "restart": ["Stage parts before the break ends.", "Run a warm-up cycle before the line restarts.", "Stagger breaks so the line never restarts cold."],
};

// ============================================================ helpers
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pad2 = (n) => String(n).padStart(2, "0");
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
const fmtHM = (secOfDay) => pad2(Math.floor(secOfDay / 3600) % 24) + ":" + pad2(Math.floor(secOfDay / 60) % 60);
const isoToSec = (iso) => { const t = iso.split("T")[1]; const [h, m] = t.split(":").map(Number); return h * 3600 + m * 60; };
const hhmmToSec = (s) => { const [h, m] = s.split(":").map(Number); return h * 3600 + m * 60; };
const dayNo = (d) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
const dateOfDayNo = (n) => { const o = new Date(n * 86400000); return o.getUTCFullYear() + "-" + pad2(o.getUTCMonth() + 1) + "-" + pad2(o.getUTCDate()); };
const weekday = (d) => new Date(dayNo(d) * 86400000).getUTCDay();
const abs = (date, secOfDay) => dayNo(date) * 86400 + secOfDay;       // absolute seconds
const fmtDate = (d) => { const [, m, dd] = d.split("-").map(Number); return WEEKDAYS[weekday(d)] + " " + pad2(dd) + " " + MONTHS[m - 1]; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const fl = (x) => Math.floor(x + 1e-6);

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ============================================================ data model
let DATA = null, CONFIG = { view: "3d", ai: false };
let VIEW_2D = false;
const DAYS = {};      // date -> per-shift model
let DATES = [];
let HOUR_TO = new Map();   // hour id -> absolute end second

function buildDay(date) {
  const hours = DATA.hours.filter((h) => h.date === date).sort((a, b) => a.hour - b.hour);
  const downs = DATA.downtimes.filter((d) => d.date === date).map((d) => ({
    ...d, s: isoToSec(d.from) - SHIFT_START_S, e: isoToSec(d.to) - SHIFT_START_S,
  })).sort((a, b) => a.s - b.s);
  // minute status: 0 run, 1 planned pause, 2 downtime
  const status = new Uint8Array(480);
  for (const h of hours) {
    const base = (h.hour - 1) * 60;
    for (let i = 0; i < (h.am_min || 0) + (h.pause_min || 0); i++) status[base + i] = 1;
  }
  for (const d of downs) for (let m = Math.floor(d.s / 60); m < Math.ceil(d.e / 60); m++) if (status[m] === 0) status[m] = 2;
  // spread each hour's totals over its running minutes -> cumulative arrays
  const keys = ["plan", "run", "down", "produced", "ok", "nok", "micro", "retest", "slow"];
  const cum = Object.fromEntries(keys.map((k) => [k, new Float64Array(481)]));
  for (const h of hours) {
    const base = (h.hour - 1) * 60;
    let runN = 0;
    for (let i = 0; i < 60; i++) if (status[base + i] === 0) runN++;
    if (runN !== h.run_min) console.warn("run minutes mismatch", h.id, runN, h.run_min);
    for (let i = 0; i < 60; i++) {
      const m = base + i, st = status[m], r = st === 0 && runN ? 1 / runN : 0;
      const inc = { plan: st !== 1 ? 1 : 0, run: st === 0 ? 1 : 0, down: st === 2 ? 1 : 0,
        produced: h.produced * r, ok: h.ok * r, nok: h.nok * r,
        micro: h.microstop_s * r, retest: h.retest_s * r, slow: h.slowdown_s * r };
      for (const k of keys) cum[k][m + 1] = cum[k][m] + inc[k];
    }
  }
  return { date, hours, downs, status, cum };
}

function sampleCum(day, t) {
  const m = clamp(Math.floor(t / 60), 0, 479), f = clamp((t - m * 60) / 60, 0, 1), o = {};
  for (const k in day.cum) { const a = day.cum[k]; o[k] = a[m] + (a[m + 1] - a[m]) * f; }
  return o;
}
// Whole minutes that always add up: planned = stopped + running; running = made + slow; made = good + defects.
// One part = one minute at the 60 s ideal cycle. Same rule as the "Line stopped" card (minutes started, floored).
function wholeMinutes(c) {
  const stopped = fl(c.down), running = fl(c.run), prod = Math.min(fl(c.produced), running), good = Math.min(fl(c.ok), prod);
  return { stopped, running, plan: stopped + running, prod, good, slow: running - prod };
}
function diffCum(a, b) { const o = {}; for (const k in a) o[k] = b[k] - a[k]; return o; }
function kpis(c) {
  const A = c.plan ? c.run / c.plan : NaN, P = c.run ? c.produced / c.run : NaN, Q = c.produced ? c.ok / c.produced : NaN;
  return { A, P, Q, OEE: A * P * Q };
}

// ============================================================ past-only analysis
// Everything here is computed for one moment (absolute second) from data before it.
let AN = null, AN_KEY = null;
const nowAbs = () => abs(sim.date, SHIFT_START_S + sim.t);

function analysis() {
  const now = nowAbs(), key = Math.floor(now / 60);
  if (AN && AN_KEY === key) return AN;
  AN_KEY = key;
  AN = analyse(now);
  return AN;
}

function analyse(now) {
  const tgt = DATA.meta.target_oee;
  const days = DATES.filter((d) => abs(d, SHIFT_START_S) <= now).map((d) => {
    const t = clamp(now - abs(d, SHIFT_START_S), 0, SHIFT_LEN_S);
    return { date: d, t, done: t >= SHIFT_LEN_S, c: sampleCum(DAYS[d], t) };
  });
  const mtd = { plan: 0, run: 0, down: 0, produced: 0, ok: 0, nok: 0, micro: 0, retest: 0, slow: 0 };
  for (const x of days) for (const k in mtd) mtd[k] += x.c[k];
  const K = kpis(mtd);
  // OEE = good minutes / planned minutes (ideal cycle 60 s), so a recovered minute is worth:
  const P = isFinite(K.P) ? K.P : 1, Q = isFinite(K.Q) ? K.Q : 1, plan = mtd.plan || 1;
  const ptsDown = (min) => (min * P * Q / plan) * 100;   // stop removed: it runs at the usual speed and quality
  const ptsSpeed = (min) => (min * Q / plan) * 100;      // slow minute removed
  const ptsNok = (pcs) => (pcs / plan) * 100;            // one bad part fewer

  // stops that have started, minutes clipped at now
  const downs = DATA.downtimes.map((d) => {
    const s = abs(d.date, isoToSec(d.from)), e = abs(d.date, isoToSec(d.to));
    return { ...d, sAbs: s, eAbs: e, known: Math.max(0, Math.min(d.min, (now - s) / 60)), ongoing: e > now };
  }).filter((d) => d.sAbs <= now);
  // defects whose hour is over
  const noks = DATA.nok.filter((n) => HOUR_TO.has(n.hour_id) && HOUR_TO.get(n.hour_id) <= now);

  // repeats: same code, same weekday, same start time
  const groups = {};
  for (const d of downs) {
    const k = d.code + "|" + weekday(d.date) + "|" + d.from.slice(11);
    (groups[k] = groups[k] || []).push(d);
  }
  const patterns = [];
  for (const [k, ev] of Object.entries(groups)) {
    const [code, wdS, hhmm] = k.split("|"), wd = Number(wdS), slot = hhmmToSec(hhmm);
    const opp = DATES.filter((d) => weekday(d) === wd && abs(d, slot) <= now).length;
    if (ev.length < PATTERN_MIN_HITS || ev.length / opp < PATTERN_MIN_SHARE) continue;
    const min = ev.reduce((s, e) => s + e.known, 0);
    const doneEv = ev.filter((e) => !e.ongoing);                // average only over stops that have ended
    const avg = doneEv.length ? doneEv.reduce((s, e) => s + e.min, 0) / doneEv.length : NaN;
    // next slot after now (calendar, not the data: the data must not tell us the future)
    let next = null;
    for (let i = 0; i <= 14 && !next; i++) {
      const nd = dateOfDayNo(dayNo(sim.date) + i);
      if (weekday(nd) === wd && abs(nd, slot) > now) next = nd;
    }
    patterns.push({
      code, wd, hhmm, slot, hits: ev.length, opp, level: ev.length >= PATTERN_CONFIRMED ? "confirmed" : "watch",
      min, avg, station: ev[0].station, cause: ev[0].cause_en, events: ev, next,
    });
  }
  patterns.sort((a, b) => (a.level === b.level ? b.min - a.min : a.level === "confirmed" ? -1 : 1));

  // issues, each with OEE points gained if fixed
  const issues = [];
  const byStation = {};
  for (const d of downs) {
    const b = (byStation[d.station] = byStation[d.station] || { min: 0, n: 0, code: d.code, cause: d.cause_en, codes: new Set() });
    b.min += d.known; b.n++; b.codes.add(d.code);
  }
  for (const p of patterns) {
    issues.push({ id: "pat|" + p.code + "|" + p.wd + "|" + p.hhmm, kind: "pattern", level: p.level, title: shortName(p.station),
      code: p.code, station: p.station, value: p.min, unit: "min", sub: `${p.level === "watch" ? "Watch: " : "Every "}${WEEKDAYS_LONG[p.wd]} ${p.hhmm}`,
      pts: ptsDown(p.min), pattern: p, topic: { topic: "code", code: p.code } });
  }
  for (const [station, b] of Object.entries(byStation)) {
    const patMin = patterns.filter((p) => p.station === station).reduce((s, p) => s + p.min, 0);
    const rest = b.min - patMin, restN = b.n - patterns.filter((p) => p.station === station).reduce((s, p) => s + p.hits, 0);
    if (rest < 0.5 || restN <= 0) continue;
    issues.push({ id: "st|" + station, kind: "stops", title: shortName(station), code: b.code, station, value: rest, unit: "min",
      sub: `${restN} stop${restN > 1 ? "s" : ""}`, pts: ptsDown(rest), topic: { topic: "code", code: b.code } });
  }
  // speed loss in hours with a planned pause vs the other hours (finished hours only)
  const byHour = {};
  for (const h of DATA.hours) {
    if (abs(h.date, isoToSec(h.to)) > now) continue;
    const b = (byHour[h.hour] = byHour[h.hour] || { run: 0, prod: 0, pause: 0 });
    b.run += h.run_min; b.prod += h.produced; b.pause += (h.am_min || 0) + (h.pause_min || 0);
  }
  const pauseHours = Object.keys(byHour).filter((h) => byHour[h].pause > 0).map(Number);
  const others = Object.keys(byHour).filter((h) => byHour[h].pause === 0);
  let restart = null;
  if (pauseHours.length && others.length) {
    const Pref = others.reduce((s, h) => s + byHour[h].prod, 0) / others.reduce((s, h) => s + byHour[h].run, 0);
    let lost = 0;
    const parts = pauseHours.map((h) => { const Ph = byHour[h].prod / byHour[h].run; lost += Math.max(0, (Pref - Ph) * byHour[h].run); return { h, P: Ph }; });
    if (lost >= 10) {
      restart = { lost, parts, Pref };
      issues.push({ id: "restart", kind: "speed", title: "Restart after breaks", code: "Speed", value: lost, unit: "min",
        sub: `Hours ${pauseHours.join(" and ")} run slow`, pts: ptsSpeed(lost), restart, topic: { topic: "restart" } });
    }
  }
  // most common defect
  const nokBy = {};
  for (const n of noks) { const b = (nokBy[n.code] = nokBy[n.code] || { qty: 0, cat: n.category, station: n.station }); b.qty += n.qty; }
  const topNok = Object.entries(nokBy).sort((a, b) => b[1].qty - a[1].qty)[0];
  if (topNok) {
    const [code, b] = topNok;
    issues.push({ id: "nok|" + code, kind: "defect", title: DEFECT_ISSUE[b.cat] || code, code, station: b.station, value: b.qty, unit: "pcs",
      sub: "Most common defect", pts: ptsNok(b.qty), topic: { topic: "code", code } });
  }
  issues.sort((a, b) => b.pts - a.pts);

  // top 3 errors: error codes (stops ST-..., defects Q-...) by OEE points they took, month to date
  const errBy = {};
  for (const d of downs) {
    const e = (errBy[d.code] = errBy[d.code] || { code: d.code, kind: "stop", station: d.station, cause: d.cause_en, value: 0, n: 0 });
    e.value += d.known; e.n++;
  }
  for (const x of noks) {
    const e = (errBy[x.code] = errBy[x.code] || { code: x.code, kind: "defect", station: x.station, cause: x.cause_en, value: 0, n: 0 });
    e.value += x.qty; e.n++;
  }
  const patCodes = new Set(patterns.map((p) => p.code));
  const topErrors = Object.values(errBy).map((e) => ({ ...e, pts: e.kind === "stop" ? ptsDown(e.value) : ptsNok(e.value), repeats: patCodes.has(e.code) }))
    .sort((a, b) => b.pts - a.pts).slice(0, 3);

  // shifts below target: all on one weekday? (finished shifts only)
  const done = days.filter((x) => x.done).map((x) => ({ date: x.date, OEE: kpis(x.c).OEE }));
  const below = done.filter((x) => x.OEE < tgt);
  let dayNote = null;
  const wds = [...new Set(below.map((x) => weekday(x.date)))];
  if (below.length >= 2 && wds.length === 1) dayNote = { wd: wds[0], n: below.length, of: done.filter((x) => weekday(x.date) === wds[0]).length };

  return { now, days, mtd, K, downs, noks, patterns, issues, topErrors, byStation, nokBy, restart, dayNote };
}

// ============================================================ 3D scene (created only in 3D view)
const canvas = $("scene");
let renderer = null, scene = null, camera = null, sun = null, hazeScene = null, hazeCam = null, hazeMat = null;
const camTarget = new THREE.Vector3();
const camDir = CAMERA_OFFSET.clone().normalize();
// where the camera looks: x moves between the first and the last station, y = 1.5 m (machines, not the floor)
const track = { x: 0, minX: 0, maxX: 0, y: 1.5, z: 0, pitch: 1 };
let lineH = 1;                            // view height that shows the whole line (zoom-out limit)
const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();

function init3D() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.autoClear = false;
  scene = new THREE.Scene();
  // No scene.background: a Color background clears on every render() and would wipe pass 1 of the focus mode.
  renderer.setClearColor(BG_HEX, 1);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xc4c8cb, 1.5);
  sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(hemi, sun, sun.target);
  for (const l of [hemi, sun]) l.layers.enable(1);
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
  hazeScene = new THREE.Scene();
  hazeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  hazeMat = new THREE.MeshBasicMaterial({ color: BG_HEX, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  hazeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hazeMat));
}

function tileTexture(size, tiles, base, seam) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), s = size / tiles;
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = seam; g.lineWidth = Math.max(2, size / 256);
  for (let i = 0; i <= tiles; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(size, i * s); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// ============================================================ line model (3D or 2D share this)
const L01 = { root: null, mixer: null, stations: [], byName: {}, meshes: [] };
let contentBox = new THREE.Box3();

async function loadModel() {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL, (e) => {
    if (e.total) $("ld-msg").textContent = Math.round((e.loaded / e.total) * 100) + "% of model";
  });
  const root = gltf.scene;
  root.name = "L01";
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const roots = root.children.filter((c) => c.userData && c.userData.stage !== undefined);
  roots.sort((a, b) => a.position.x - b.position.x);
  L01.mixer = new THREE.AnimationMixer(root);
  roots.forEach((r, i) => {
    let prefix = null;
    r.traverse((o) => { if (!prefix && /_Andon_G$/.test(o.name)) prefix = o.name.replace(/_Andon_G$/, ""); });
    const lamps = {};
    for (const k of ["G", "Y", "R"]) {
      const m = r.getObjectByName(prefix + "_Andon_" + k);
      if (m && m.material) { const mat = m.material; mat.userData.base = mat.color.clone(); mat.userData.on = mat.color.clone(); lamps[k] = mat; }
    }
    const actions = gltf.animations.filter((a) => a.name.startsWith(prefix + "_")).map((clip) => { const a = L01.mixer.clipAction(clip); a.play(); return a; });
    const dur = actions.length ? Math.max(...actions.map((a) => a.getClip().duration)) : 10;
    const sbox = new THREE.Box3().setFromObject(r);
    const stage = String(r.userData.stage);
    const st = {
      name: r.name, idx: i, root: r, prefix, lamps, actions, dur, t: 0, parked: false, held: false, sync: true,
      pallet: r.getObjectByName(prefix + "_Pallet"), box: sbox,
      stage: stage === "lift_in" ? "IN" : stage === "lift_out" ? "OUT" : stage,
      code: r.userData.st_code && r.userData.st_code !== "-" ? r.userData.st_code : null,
      mechanism: r.userData.mechanism, state: "run", reason: null, label: null,
    };
    r.traverse((o) => { if (o.isMesh) { o.userData.station = st.name; L01.meshes.push(o); } });
    L01.stations.push(st);
    L01.byName[st.name] = st;
  });
  L01.root = root;
  scene.add(root);

  scene.updateMatrixWorld(true);
  contentBox = new THREE.Box3().expandByObject(root);
  const c = contentBox.getCenter(new THREE.Vector3()), s = contentBox.getSize(new THREE.Vector3());
  const floorTex = tileTexture(1024, 8, [236, 238, 241], "#d3d7dd");
  const floorW = 420, floorD = 420;           // big enough that its edge never shows in the diagonal view
  floorTex.repeat.set(floorW / 16, floorD / 16);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(c.x, contentBox.min.y - 0.01, c.z);
  floor.receiveShadow = true;
  scene.add(floor);

  sun.position.set(c.x - 25, 40, c.z + 30);
  sun.target.position.copy(c);
  const sc = sun.shadow.camera, r = Math.max(s.x, s.z) * 0.75 + 10;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 1; sc.far = 140;
  sc.updateProjectionMatrix();

  camTarget.copy(c);
  camera.position.copy(camTarget).addScaledVector(camDir, 300);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  camUp.setFromMatrixColumn(camera.matrixWorld, 1);
  const cx = (st) => (st.box.min.x + st.box.max.x) / 2;
  const sts = L01.stations, half = Math.floor(SECTION_STATIONS / 2);
  track.minX = (cx(sts[half - 1]) + cx(sts[half])) / 2;                       // first section: stations 1..4
  track.maxX = (cx(sts[sts.length - half - 1]) + cx(sts[sts.length - half])) / 2;
  track.pitch = (cx(sts[sts.length - 1]) - cx(sts[0])) / (sts.length - 1);
  track.x = track.minX; track.z = c.z; track.y = clamp(1.5, contentBox.min.y, contentBox.max.y);
  camera.near = 1; camera.far = 700;
  buildLabels();
}

function build2D() {
  document.body.classList.add("v2d");
  const wrap = $("line2d");
  wrap.classList.remove("hidden");
  wrap.innerHTML = '<div class="l2-row"></div><div class="l2-belt"></div><div class="l2-names"></div>';
  const row = wrap.querySelector(".l2-row"), names = wrap.querySelector(".l2-names");
  STATIONS.forEach(([name, stage, code], i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "st2 run";
    el.title = `${longName(name)}${code ? " · " + code : ""}`;
    el.innerHTML = `<span class="lamp"></span><span class="box"><span>${esc(code || stage)}</span></span>`;
    el.addEventListener("click", () => (focus && focus.name === name ? unfocus() : focusStation(name)));
    row.appendChild(el);
    const nm = document.createElement("span");
    nm.textContent = shortName(name);
    names.appendChild(nm);
    const st = { name, idx: i, stage, code, mechanism: "", state: "run", reason: null, label: el, nameEl: nm,
      actions: [], lamps: {}, pallet: null, dur: 10, t: 0, parked: false };
    L01.stations.push(st);
    L01.byName[name] = st;
  });
}

// ============================================================ camera (pan + zoom only)
const view = { cx: 0, cy: 0, h: 10 };
let fitView = null, contentRect = null, anim = null;
const toView = (p) => { const d = p.clone().sub(camTarget); return { x: d.dot(camRight), y: d.dot(camUp) }; };
function rectOfBox(box) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const v = toView(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}
function insets() {
  const H = window.innerHeight;
  // in the diagonal view the corners are empty: the "Line stopped" card sits top-left, the legend bottom-right
  const top = $("top").offsetHeight + 12;
  const bottom = $("bottom").offsetHeight + 12;
  const right = focus ? $("card").offsetWidth + 40 : 0;
  return { top, bottom, right, H, W: window.innerWidth };
}
function sectionCenter(x) { return toView(new THREE.Vector3(x, track.y, track.z)); }
function computeFit() {
  contentRect = rectOfBox(contentBox);
  const { top, bottom, H, W } = insets();
  const aspect = W / H, free = Math.max(0.15, 1 - (top + bottom) / H);
  const main = rectOfBox(new THREE.Box3().setFromObject(L01.root));
  lineH = Math.max(main.w / (2 * aspect), main.h / (2 * free)) * 1.04;
  const sec = new THREE.Box3();
  for (const st of L01.stations.slice(0, SECTION_STATIONS)) sec.union(st.box);
  const r = rectOfBox(sec), c = sectionCenter(track.x);
  fitView = { cx: c.x, cy: c.y, h: Math.max(r.w / (2 * aspect), r.h / (2 * free)) * 1.1 };
}
// move the look-at point along the conveyor; the camera keeps the same angle and zoom
function moveAlongConveyor(dx) {
  if (VIEW_2D || !fitView) return;
  track.x = clamp(track.x + dx, track.minX, track.maxX);
  const c = sectionCenter(track.x);
  fitView.cx = c.x; fitView.cy = c.y;
  anim = null;
  view.cx = c.x; view.cy = c.y;
}

function applyView() {
  const { top, bottom, right, H, W } = insets();
  const aspect = W / H, c = (bottom - top) / H, cr = right / W;
  const mx = view.cx + view.h * aspect * cr, my = view.cy - view.h * c;
  camera.left = mx - view.h * aspect; camera.right = mx + view.h * aspect;
  camera.top = my + view.h; camera.bottom = my - view.h;
  camera.updateProjectionMatrix();
}
function clampView() {
  if (!fitView) return;
  view.h = clamp(view.h, fitView.h * 0.3, lineH * 1.05);
  view.cx = clamp(view.cx, contentRect.minX, contentRect.maxX);
  view.cy = clamp(view.cy, contentRect.minY, contentRect.maxY);
}
function animateView(to, ms = 700) { anim = { from: { ...view }, to, t0: performance.now(), ms }; }
function stepAnim(now) {
  if (!anim) return;
  const k = clamp((now - anim.t0) / anim.ms, 0, 1), e = ease(k);
  for (const key of ["cx", "cy", "h"]) view[key] = anim.from[key] + (anim.to[key] - anim.from[key]) * e;
  if (k >= 1) anim = null;
}
// re-fit after the panels change height; keep the user's zoom if they zoomed
function refit() {
  if (VIEW_2D || !L01.root) return;
  const wasFit = fitView && Math.abs(view.h - fitView.h) < 1e-6 && Math.abs(view.cx - fitView.cx) < 1e-6;
  computeFit();
  if (wasFit && !focus) animateView(fitView, 300);
}

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (VIEW_2D) return;
  drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (VIEW_2D || !camera) return;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) { drag.moved = true; canvas.classList.add("grab"); }
    if (drag.moved && !focus) {                                  // drag = move along the line
      const H = window.innerHeight;
      moveAlongConveyor(-(dx * (2 * view.h / H)) / Math.max(0.2, camRight.x));
    }
    drag.x = e.clientX; drag.y = e.clientY;
  } else hoverAt(e.clientX, e.clientY);
});
canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("grab");
  if (drag && !drag.moved) clickAt(e.clientX, e.clientY);
  drag = null;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (VIEW_2D || focus || !fitView) return;
  if (!e.ctrlKey) { moveAlongConveyor(((e.deltaY + e.deltaX) / 100) * track.pitch * 0.5); return; }   // wheel = along the line
  anim = null;
  const W = window.innerWidth, H = window.innerHeight, aspect = W / H;
  const nx = (e.clientX / W) * 2 - 1, ny = -(e.clientY / H) * 2 + 1;
  const wx = (camera.left + camera.right) / 2 + nx * view.h * aspect, wy = (camera.top + camera.bottom) / 2 + ny * view.h;
  const offX = (camera.left + camera.right) / 2 - view.cx, offY = (camera.top + camera.bottom) / 2 - view.cy;
  const nh = clamp(view.h * Math.exp(e.deltaY * 0.0012), fitView.h * 0.3, lineH * 1.05);
  const k = nh / view.h;
  view.h = nh;
  view.cx = wx - nx * nh * aspect - offX * k;
  view.cy = wy - ny * nh - offY * k;
  clampView();
}, { passive: false });

// ============================================================ picking & focus
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let pickables = [];
let focus = null, hovered = null, prevView = null;

function pick(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  return hit ? hit.object.userData : null;
}
let hoverQueued = false;
function hoverAt(x, y) {
  if (hoverQueued || focus) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    const u = pick(x, y);
    const name = u && u.station ? u.station : null;
    if (name !== hovered) {
      if (hovered && L01.byName[hovered]) L01.byName[hovered].label.classList.remove("hl");
      hovered = name;
      if (hovered) L01.byName[hovered].label.classList.add("hl");
    }
    canvas.classList.toggle("hover", !!(u && u.station));
  });
}
function clickAt(x, y) {
  const u = pick(x, y);
  if (!u) { if (focus) unfocus(); return; }
  if (u.station) focusStation(u.station);
}
function setLayer1(obj, on) { obj.traverse((o) => (on ? o.layers.enable(1) : o.layers.disable(1))); }

function focusStation(name) {
  const st = L01.byName[name];
  if (!st) return;
  document.body.classList.add("focus");
  if (VIEW_2D) {
    focus = st;
    $("card").classList.add("open");
    lastCardHtml = "";
    renderCard();
    return;
  }
  if (focus && focus !== st) setLayer1(focus.root, false);
  if (!focus) prevView = { ...view };
  focus = st;
  setLayer1(st.root, true);
  $("card").classList.add("open");
  lastCardHtml = "";
  renderCard();
  // Fit the station into the free band, then never end up farther than 60% of the view before the click.
  // (Before: the band is narrow and stations are tall, so "fit with margin" came out wider than the line view.)
  const r = rectOfBox(st.box);
  const H = window.innerHeight, W = window.innerWidth, aspect = W / H;
  const free = Math.max(0.2, 1 - ($("top").offsetHeight + $("bottom").offsetHeight + 40) / H);
  const freeW = Math.max(0.3, 1 - ($("card").offsetWidth + 40) / W);
  let h = Math.max(r.h / (2 * free), r.w / (2 * aspect * freeW)) * 1.15;
  h = clamp(h, fitView.h * 0.14, prevView.h * 0.6);
  animateView({ cx: r.cx, cy: r.cy, h });
}
function unfocus() {
  if (!focus) return;
  if (!VIEW_2D) setLayer1(focus.root, false);
  focus = null;
  $("card").classList.remove("open");
  document.body.classList.remove("focus");
  if (VIEW_2D) return;
  animateView(prevView || fitView);
  prevView = null;
}

// ============================================================ labels over 3D stations
function buildLabels() {
  const host = $("labels");
  for (const st of L01.stations) {
    const el = document.createElement("div");
    el.className = "lbl run";
    el.innerHTML = `<span class="d"></span><span>${esc(shortName(st.name))}</span><span class="cd">${esc(st.code || "")}</span>`;
    el.title = `${longName(st.name)}${st.code ? " · " + st.code : ""}`;
    el.addEventListener("click", () => focusStation(st.name));
    el.addEventListener("mouseenter", () => { hovered = st.name; });
    el.addEventListener("mouseleave", () => { if (hovered === st.name) hovered = null; });
    host.appendChild(el);
    st.label = el;
    st.anchor = new THREE.Vector3((st.box.min.x + st.box.max.x) / 2, st.box.max.y + 0.15, (st.box.min.z + st.box.max.z) / 2);
  }
  pickables = [...L01.meshes];
}
const tmpV = new THREE.Vector3();
function placeLabels() {
  const W = window.innerWidth, H = window.innerHeight, topY = $("top").offsetHeight, botY = H - $("bottom").offsetHeight;
  for (const st of L01.stations) {
    const el = st.label;
    if (focus && focus !== st) { el.style.display = "none"; continue; }
    tmpV.copy(st.anchor).project(camera);
    const x = (tmpV.x + 1) / 2 * W, y = (1 - tmpV.y) / 2 * H;
    el.style.display = x < -50 || x > W + 50 || y < topY + 20 || y > botY ? "none" : "";
    el.style.left = x + "px"; el.style.top = y + "px";
  }
}

// ============================================================ simulation
const sim = { date: null, t: 0, playing: true, speed: 60 };
let blink = true, lastActive = new Set();

function stationStates(day, t) {
  const n = L01.stations.length;
  const out = L01.stations.map(() => ({ state: "run", reason: null }));
  const m = clamp(Math.floor(t / 60), 0, 479);
  if (day.status[m] === 1) { out.forEach((o) => (o.state = "pause")); return out; }
  const rank = { run: 0, starved: 1, blocked: 2, fault: 3 };
  const set = (i, state, ev) => { if (rank[state] > rank[out[i].state]) out[i] = { state, reason: ev }; };
  for (const ev of day.downs) {
    const st = L01.byName[ev.station];
    if (!st) continue;
    const k = st.idx;
    if (t >= ev.s && t < ev.e) {
      set(k, "fault", ev);
      for (let j = 0; j < k; j++) set(j, "blocked", ev);
    }
    for (let j = k + 1; j < n; j++) {
      const d = (j - k) * 60;
      if (t >= ev.s + d && t < ev.e + d) set(j, "starved", ev);
    }
  }
  return out;
}

function setLamp(st, color) {
  for (const k of ["G", "Y", "R"]) {
    const m = st.lamps[k];
    if (!m) continue;
    const on = k === color && (k !== "R" || blink);
    if (on) { m.color.copy(m.userData.base); m.emissive.copy(m.userData.on); m.emissiveIntensity = k === "R" ? 3 : 2.2; }
    else { m.color.copy(m.userData.base).multiplyScalar(0.18); m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0; }
  }
}

// One clock for the whole line: every running station shows the same point of the cycle,
// as on a real transfer line where all pallets move at once. Before, each station kept its own
// clock, so after the first stop the stations ran out of step for the rest of the replay.
// Out of step (after a stop, a wait or an empty run) a station plays 4× faster if it is behind
// the line, 4× slower if it is ahead, until it is back in step. It never stands still while green.
// A planned pause freezes the line clock too, so the line stays in step through breaks.
const lineClock = { t: 0 };
// whole line on screen: tags shrink to their status dot (name on hover and for a stopped station); zoomed in: full tags
let labelsCompact = true;
const CATCH_UP = 4;
function updateStations(dt, states) {
  const rate = sim.playing ? (sim.speed <= 1 ? 1 / 6 : sim.speed >= 600 ? 2 : 1) : 0;
  const step = dt * rate;
  const linePause = states.length && states.every((s) => s.state === "pause");
  if (!linePause) lineClock.t += step;
  states.forEach((s, i) => {
    const st = L01.stations[i];
    st.state = s.state; st.reason = s.reason;
    if (VIEW_2D) {
      const cls = "st2 " + s.state + (focus === st ? " sel" : "");
      if (st.label.className !== cls) st.label.className = cls;
      st.nameEl.className = s.state === "starved" ? "dim" : "";
      return;
    }
    const p = lineClock.t % st.dur;
    switch (s.state) {
      case "run":
        if (st.sync) { st.t = p; break; }
        if (st.parked) { st.parked = false; st.t = 0; }             // next pallet comes in
        st.held = false;
        {
          const d = ((p - st.t) % st.dur + st.dur * 1.5) % st.dur - st.dur / 2;   // >0: behind the line
          const v = step * (d >= 0 ? CATCH_UP : 1 / CATCH_UP);
          if (Math.abs(d) <= step * CATCH_UP + 1e-4) { st.t = p; st.sync = true; } else st.t = (st.t + v) % st.dur;
        }
        break;
      case "blocked": {
        st.sync = false; st.parked = false;
        if (!st.held) {
          const nt = st.t + step;
          if (st.t <= BLOCK_HOLD_S && nt >= BLOCK_HOLD_S) { st.t = BLOCK_HOLD_S; st.held = true; } else st.t = nt % st.dur;
        }
        break;
      }
      case "starved":
        st.sync = false; st.held = false;
        if (!st.parked) { st.t += step; if (st.t >= st.dur) { st.t = 0; st.parked = true; } }
        break;
      case "fault":
        st.sync = false;
        break;
      default: break;                                                // planned pause: line clock is frozen too
    }
    if (st.pallet) st.pallet.visible = !st.parked;
    for (const a of st.actions) a.time = st.t;
    setLamp(st, s.state === "run" ? "G" : s.state === "fault" ? "R" : s.state === "pause" ? null : "Y");
    const cls = "lbl " + s.state + (hovered === st.name ? " hl" : "") + (labelsCompact && s.state !== "fault" ? " c" : "");
    if (st.label.className !== cls) st.label.className = cls;
  });
  if (!VIEW_2D) L01.mixer.update(0);
}

function activeSet(day, t) { return new Set(day.downs.filter((d) => t >= d.s && t < d.e).map((d) => d.code + d.s)); }
function seek(t) { sim.t = clamp(t, 0, SHIFT_LEN_S - 1); lastActive = activeSet(DAYS[sim.date], sim.t); }

function setDate(d, t) {
  sim.date = d;
  $("shift-select").value = d;
  buildPauses();
  seek(t === undefined ? sim.t : t);
  AN_KEY = null;
  if (focus) { lastCardHtml = ""; renderCard(); }
}

// ============================================================ top: sign + timeline (past only)
const pctOf = (s) => (s / SHIFT_LEN_S) * 100;
let pauseHtml = "";
function buildPauses() {
  const day = DAYS[sim.date];
  let html = "", m = 0;
  while (m < 480) {
    if (day.status[m] === 1) { const s = m; while (m < 480 && day.status[m] === 1) m++; html += `<div class="pause" style="left:${pctOf(s * 60)}%;width:${pctOf((m - s) * 60)}%" title="Planned pause ${fmtHM(SHIFT_START_S + s * 60)}–${fmtHM(SHIFT_START_S + m * 60)}"></div>`; }
    else m++;
  }
  pauseHtml = html;   // planned, so the whole shift is shown
}
const laneCache = {};
function setHtml(id, html) { if (laneCache[id] !== html) { $(id).innerHTML = html; laneCache[id] = html; } }

function renderTop(an) {
  const day = DAYS[sim.date], t = sim.t, head = `<div class="head" style="left:${pctOf(t)}%"></div>`;
  const clock = fmtHM(SHIFT_START_S + t), no = pad2(DATES.indexOf(sim.date) + 1) + "/" + DATES.length, prog = pctOf(t) + "%";
  $("clock").textContent = clock; $("shift-no").textContent = no; $("shift-progress").style.width = prog;

  const rec = new Set(an.patterns.map((p) => p.code + "|" + p.hhmm + "|" + p.wd));
  let stops = pauseHtml;
  for (const d of day.downs) {
    if (d.s > t) continue;                                   // has not happened yet
    const e = Math.min(d.e, t), r = rec.has(d.code + "|" + d.from.slice(11) + "|" + weekday(d.date));
    stops += `<div class="stop${r ? " rec" : ""}" style="left:${pctOf(d.s)}%;width:${pctOf(e - d.s)}%" title="${esc(shortName(d.station))} · ${esc(d.code)} · ${fmtHM(SHIFT_START_S + d.s)}${d.e > t ? " · ongoing" : "–" + fmtHM(SHIFT_START_S + d.e)}${r ? " · repeats" : ""}"></div>`;
  }
  setHtml("lane-stops", stops + head);
  let slow = "", nok = "";
  for (let h = 0; h < 8; h++) {
    const s0 = h * 3600;
    if (s0 > t) { slow += "<span></span>"; nok += "<span></span>"; continue; }
    const c = diffCum(sampleCum(day, s0), sampleCum(day, Math.min(t, s0 + 3600)));
    const v = Math.max(0, c.run - c.produced), n = fl(c.nok);
    const cls = v >= 5 ? "c3" : v >= 2 ? "c2" : v > 0.01 ? "c1" : "";
    slow += `<span class="${cls}" title="${pad2(6 + h)}:00–${pad2(7 + h)}:00 · slow ${v.toFixed(1)} min">${v > 0.01 ? (v < 0.5 ? "&lt;1" : Math.round(v)) : ""}</span>`;
    nok += `<span class="${n ? "c1" : ""}" title="${pad2(6 + h)}:00–${pad2(7 + h)}:00 · ${n} NOK">${n || ""}</span>`;
  }
  setHtml("lane-slow", slow + head);
  setHtml("lane-nok", nok + head);
}
(() => {
  const tl = $("timeline");
  let dragging = false;
  const go = (e) => { const r = $("lane-stops").getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * SHIFT_LEN_S); };
  tl.addEventListener("pointerdown", (e) => { dragging = true; tl.setPointerCapture(e.pointerId); go(e); });
  tl.addEventListener("pointermove", (e) => dragging && go(e));
  tl.addEventListener("pointerup", () => (dragging = false));
})();

// ============================================================ stage: "Line stopped" card
function faultsNow(states) {
  return states.map((s, i) => ({ s, st: L01.stations[i] })).filter((x) => x.s.state === "fault")
    .map((x) => ({ st: x.st, ev: x.s.reason, min: Math.max(0, Math.floor((sim.t - x.s.reason.s) / 60)) }))
    .sort((a, b) => b.min - a.min);
}
let lastStoppedHtml = null;
function renderStopped(states) {
  const f = faultsNow(states);
  let html = "";
  if (f.length) {
    html = `<div class="hd"><b>Line stopped</b><span>${f.length} STATION${f.length > 1 ? "S" : ""}</span></div>` +
      f.slice(0, 3).map((x) => `<div class="row"><div><div class="nm">${esc(longName(x.st.name))}</div><div class="sub">${esc(x.ev.code)} · since ${fmtHM(SHIFT_START_S + x.ev.s)}</div></div>
        <span class="min">${x.min} min</span><button type="button" class="btn-acc" data-focus="${esc(x.st.name)}">Show →</button></div>`).join("") +
      (f.length > 3 ? `<div class="more">+${f.length - 3} more</div>` : "");
  }
  if (html === lastStoppedHtml) return;
  lastStoppedHtml = html;
  if (html) $("stopped").innerHTML = html;          // empty: keep the old rows while the card fades out
  $("stopped").classList.toggle("show", !!html);
}
$("stopped").addEventListener("click", (e) => { const b = e.target.closest("[data-focus]"); if (b) focusStation(b.dataset.focus); });

// ============================================================ bottom panel
let curTab = "now", panelOpen = true;
function setPanel(open) {
  panelOpen = open;
  $("bottom").classList.toggle("collapsed", !open);
  $("panel-toggle").setAttribute("aria-expanded", open);
  $("panel-toggle").querySelector("span").textContent = open ? "HIDE" : "SHOW";
}
$("panel-toggle").addEventListener("click", () => setPanel(!panelOpen));
$("panel").addEventListener("transitionend", (e) => { if (e.target === $("panel") && e.propertyName === "height") layout(); });
function setTab(name) {
  if (!panelOpen) setPanel(true);
  curTab = name;
  for (const b of $("tabs").children) { const on = b.dataset.tab === name; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); }
  for (const t of ["now", "loss", "ai"]) $("tab-" + t).classList.toggle("hidden", t !== name);
  lastLossHtml = ""; lastAiHtml = "";
  renderPanels(true);
  layout();
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });

// --- SHIFT NOW: built once, numbers updated in place so the drawer can slide
const nowUI = { open: false, rate: "A" };
const CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#FFFFFF" stroke-width="2" aria-hidden="true"><path d="M2 4l4 4 4-4"/></svg>';
function buildNow() {
  const rate = (k, name, parts) => `<div class="rate" data-rate="${k}">
      <button type="button" aria-expanded="${nowUI.rate === k}"><span class="l">${CHEV}${name}</span><span class="v" data-k="${k}">—</span></button>
      <div class="bar"><i data-k="${k}bar"></i></div>
      <div class="pw${nowUI.rate === k ? " open" : ""}"><div><div class="parts">${parts}</div></div></div></div>`;
  const ctr = (k, name, unit) => `<div class="ctr" data-c="${k}"><div class="h">${name}</div><div class="v"><span data-k="${k}">—</span>${unit ? `<small>${unit}</small>` : ""}</div></div>`;
  $("tab-now").innerHTML = `<div class="now">
    <section class="oee"><div class="vlab">OEE · SHIFT</div><div class="oee-col">
      <div class="oee-num"><span data-k="oee">—</span><small>%</small></div>
      <div class="goal"><span class="g" data-k="goal">Goal 85%</span><span class="d" data-k="delta">—</span></div></div></section>
    <div class="pull"><button type="button" id="pull" aria-expanded="false" aria-controls="drawer" aria-label="Show availability, performance and quality"><span class="vlab">DETAILS</span></button>
      <svg width="23" height="183" viewBox="0 0 22 140" aria-hidden="true"><polygon points="2,2 20,70 2,138" fill="#FFFFFF"/></svg></div>
    <section class="drawer" id="drawer" aria-label="Availability, performance and quality">
      ${rate("A", "Availability", `<span>Planned <b data-k="a1">0</b> min</span><span>Stopped <b data-k="a2">0</b> min</span><span>Running <b data-k="a3">0</b> min</span>`)}
      ${rate("P", "Performance", `<span>Could make <b data-k="p1">0</b></span><span>Made <b data-k="p2">0</b></span><span>Slow work <b data-k="p3">0</b> min</span>`)}
      ${rate("Q", "Quality", `<span>Made <b data-k="q1">0</b></span><span>Good <b data-k="q2">0</b></span><span>Defects <b data-k="q3">0</b></span>`)}
    </section>
    <section class="bay" aria-label="Shift counters">${ctr("prod", "Produced")}${ctr("good", "Good")}${ctr("nok", "Defects")}${ctr("stop", "Stopped", "min")}${ctr("slow", "Slow work", "min")}</section>
  </div>`;
}
$("tab-now").addEventListener("click", (e) => {
  if (e.target.closest("#pull")) {
    nowUI.open = !nowUI.open;
    $("pull").setAttribute("aria-expanded", nowUI.open);
    $("drawer").classList.toggle("open", nowUI.open);
    $("drawer").parentElement.classList.toggle("open", nowUI.open);
    return;
  }
  const r = e.target.closest(".rate>button");
  if (r) {
    const k = r.parentElement.dataset.rate;
    nowUI.rate = nowUI.rate === k ? null : k;
    for (const el of $("tab-now").querySelectorAll(".rate")) {
      const on = el.dataset.rate === nowUI.rate;
      el.querySelector("button").setAttribute("aria-expanded", on);
      el.querySelector(".pw").classList.toggle("open", on);
    }
  }
});
function setK(k, v) { const el = $("tab-now").querySelector(`[data-k="${k}"]`); if (el && el.textContent !== String(v)) el.textContent = v; }
function renderNow() {
  const day = DAYS[sim.date], c = sampleCum(day, sim.t), k = kpis(c), tgt = DATA.meta.target_oee;
  const m = wholeMinutes(c), prod = m.prod, good = m.good, nok = prod - good, slow = m.slow;
  setK("oee", isFinite(k.OEE) ? (k.OEE * 100).toFixed(1) : "—");
  setK("goal", "Goal " + pct(tgt, 0));
  const d = $("tab-now").querySelector('[data-k="delta"]');
  let dh;
  if (!isFinite(k.OEE)) dh = "Shift not started";
  else {
    const pts = (k.OEE - tgt) * 100, up = pts >= 0;
    dh = `<svg width="14" height="16" viewBox="0 0 14 16" role="img" aria-label="${up ? "Above" : "Below"} goal"><polygon points="${up ? "7,0 14,16 0,16" : "0,0 14,0 7,16"}" fill="${up ? "#3BA55C" : "#D0473D"}"/></svg>${Math.abs(pts).toFixed(1)} points ${up ? "above" : "below"} goal`;
  }
  if (d.innerHTML !== dh) d.innerHTML = dh;
  for (const [key, v] of [["A", k.A], ["P", k.P], ["Q", k.Q]]) {
    setK(key, pct(v));
    const bar = $("tab-now").querySelector(`[data-k="${key}bar"]`);
    bar.style.width = (isFinite(v) ? v * 100 : 0) + "%";
  }
  setK("a1", m.plan); setK("a2", m.stopped); setK("a3", m.running);
  setK("p1", m.running); setK("p2", prod); setK("p3", slow);
  setK("q1", prod); setK("q2", good); setK("q3", nok);
  setK("prod", prod); setK("good", good); setK("nok", nok); setK("stop", m.stopped); setK("slow", slow);
}

// --- LOSSES
let lastLossHtml = "";
function lrows(list, max) {
  if (!list.length) return '<div class="none">Nothing yet this month.</div>';
  return list.map(([k, v]) => `<div class="lrow"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="t"><i style="width:${max ? (v / max) * 100 : 0}%"></i></span><span class="v">${Math.round(v)}</span></div>`).join("");
}
function renderLoss(an) {
  const day = DAYS[sim.date], c = sampleCum(day, sim.t);
  // shift so far: planned − stopped − slow − defect = good parts (1 part = 1 min at the 60 s ideal cycle)
  const m = wholeMinutes(c), good = m.good, plan = m.plan, stopped = m.stopped, defect = m.prod - m.good, slowM = m.slow;
  const term = (v, unit, k, bar) => `<div class="term"><div class="v n">${v}${unit ? `<small>${unit}</small>` : ""}</div><div class="k">${k}</div>${bar ? `<span class="u" style="background:${bar}"></span>` : '<span class="u"></span>'}</div>`;
  const op = (s) => `<div class="op">${s}</div>`;
  const M = an.mtd;
  const slowParts = [["Slowdowns", M.slow / 60], ["Micro-stops", M.micro / 60], ["Retests", M.retest / 60]];
  const slowTot = slowParts.reduce((s, x) => s + x[1], 0);
  const cat = {};
  for (const n of an.noks) cat[DEFECT_SHORT[n.category] || n.category] = (cat[DEFECT_SHORT[n.category] || n.category] || 0) + n.qty;
  const catL = Object.entries(cat).sort((a, b) => b[1] - a[1]);
  const catTot = catL.reduce((s, x) => s + x[1], 0);
  const stL = Object.entries(an.byStation).map(([st, b]) => [shortName(st), b.min]).sort((a, b) => b[1] - a[1]);
  const stTot = stL.reduce((s, x) => s + x[1], 0);
  const days = an.days.length;
  const html = `<div class="loss-shift"><div class="vlab">SHIFT</div>
      <section class="sum" aria-label="Planned minutes minus losses">
        ${term(plan, "min", "planned by " + fmtHM(SHIFT_START_S + sim.t))}${op("−")}${term(stopped, "min", "stopped", "var(--alert)")}${op("−")}${term(Math.round(slowM), "min", "slow work", "var(--accent)")}${op("−")}
        ${term(defect, "min", "defect", "var(--white)")}${op("=")}<div class="term res"><div class="v n">${good}</div><div class="k">good parts</div></div>
      </section></div>
    <div class="loss-month"><div class="vlab" title="Month to date: ${days} shift${days === 1 ? "" : "s"} up to now">MONTH</div>
      <section class="lcol"><div class="hd"><b>Slow work</b><b class="n">${Math.round(slowTot)}<small>min</small></b></div>${lrows(slowParts.filter((x) => x[1] >= 0.5), Math.max(...slowParts.map((x) => x[1])))}</section>
      <section class="lcol def"><div class="hd"><b>Defects</b><b class="n">${catTot}<small>pcs</small></b></div>${lrows(catL.slice(0, 4), catL.length ? catL[0][1] : 0)}</section>
      <section class="lcol stop"><div class="hd"><b>Stopped</b><b class="n">${Math.round(stTot)}<small>min</small></b></div>${lrows(stL.slice(0, 4), stL.length ? stL[0][1] : 0)}</section>
    </div>`;
  if (html !== lastLossHtml) { $("tab-loss").innerHTML = html; lastLossHtml = html; }
}

// --- INSIGHTS
let lastAiHtml = "";
function nextLabel(p) {
  if (!p.next) return "";
  const dd = dayNo(p.next) - dayNo(sim.date);
  return (dd === 0 ? "today" : dd === 1 ? "tomorrow" : fmtDate(p.next)) + " " + p.hhmm;
}
function renderAI(an) {
  const issues = an.issues;
  const lead = issues.find((x) => x.kind === "pattern" && x.level === "confirmed") ||
    issues.find((x) => x.kind === "pattern") || issues[0];
  const top = an.topErrors, maxE = top.length ? top[0].pts : 0;
  const fixFirst = `<aside class="fixfirst" aria-label="Top 3 errors"><div class="hd"><b>Top 3 errors</b><span>OEE points lost</span></div>
    ${top.length ? `<ol>${top.map((e, i) => `<li data-errfix="${esc(e.code)}" title="How to fix ${esc(e.code)}"><span class="no">${i + 1}</span>
      <div><div class="nm">${e.repeats ? '<span class="dia"></span>' : ""}<code>${esc(e.code)}</code>${esc(e.kind === "stop" ? shortName(e.station) : DEFECT_ISSUE[(an.noks.find((x) => x.code === e.code) || {}).category] || shortName(e.station))}</div>
      <div class="b"><i style="width:${maxE ? (e.pts / maxE) * 100 : 0}%"></i></div>
      <div class="sub">${e.kind === "stop" ? `${Math.round(e.value)} min · ${e.n} stop${e.n > 1 ? "s" : ""}` : `${e.value} pcs`} · ${esc(e.cause)}</div></div>
      <span class="p">${e.pts.toFixed(1)}</span></li>`).join("")}</ol>`
      : '<div class="note">No errors yet this month.</div>'}
    <div class="note">Month to date, up to ${fmtDate(sim.date)} ${fmtHM(SHIFT_START_S + sim.t)}</div></aside>`;

  let main;
  if (!lead) main = `<section class="finding"><h3>No findings yet</h3><div class="txt">The month has just started: no stops, slow hours or defects recorded before now.</div></section>`;
  else if (lead.kind === "pattern") {
    const p = lead.pattern, wd = WEEKDAYS_LONG[p.wd];
    const head = p.level === "confirmed" ? `${shortName(p.station)} stops every ${wd}` : `${shortName(p.station)} stopped on ${p.hits} of ${p.opp} ${wd}s`;
    const cards = p.events.slice(-5).map((e) => `<div class="evc"><span class="d">${fmtDate(e.date)}</span><span class="t n"><span class="dia"></span>${e.from.slice(11)}</span></div>`).join("") +
      (p.next ? `<div class="evc empty"><span class="d">${fmtDate(p.next)} · expected</span><span class="t n">${p.hhmm}</span></div>` : "");
    main = `<section class="finding"><div class="top"><h3>${esc(head)}</h3><span class="tag">${p.level === "confirmed" ? "Pattern" : "Watch"} · ${p.hits} of ${p.opp} past ${wd}s</span></div>
      <div class="ev">${cards}</div>
      <div class="txt">${esc(p.code)} · ${esc(p.cause)} · ${isFinite(p.avg) ? `<b>${Math.round(p.avg)} min</b> on average, ` : ""}same start ${p.hhmm}${p.events.some((e) => e.ongoing) ? ", stopped right now" : ""}.${p.level === "watch" ? " Two hits are a warning, not proof: one more " + wd + " confirms it." : ""}${an.dayNote ? ` All ${an.dayNote.n} shifts below goal were ${WEEKDAYS_LONG[an.dayNote.wd]}s.` : ""}</div>
      <div class="acts"><button type="button" class="btn-acc sm" data-fix="${esc(lead.id)}">How to fix →</button>${p.next ? `<span class="nx">Next one: <b>${esc(nextLabel(p))}</b></span>` : ""}</div></section>`;
  } else {
    let txt = "";
    if (lead.kind === "speed") txt = `Performance ${lead.restart.parts.map((x) => `hour ${x.h} ${pct(x.P)}`).join(", ")} vs ${pct(lead.restart.Pref)} in the other hours. <b>${Math.round(lead.value)} min</b> lost this month.`;
    else if (lead.kind === "stops") { const b = an.byStation[lead.station]; txt = `${esc(lead.code)} · ${esc(b.cause)} · <b>${Math.round(lead.value)} min</b> in ${lead.sub}. No fixed day or time yet.`; }
    else if (lead.kind === "defect") txt = `${esc(lead.code)} · <b>${lead.value} pcs</b> this month, the most common defect.`;
    main = `<section class="finding"><div class="top"><h3>${esc(lead.title)}</h3><span class="tag">${an.patterns.length ? "Loss" : "No repeating stop yet"} · month to date</span></div>
      <div class="txt">${txt}${an.dayNote ? ` All ${an.dayNote.n} shifts below goal were ${WEEKDAYS_LONG[an.dayNote.wd]}s.` : ""}</div>
      <div class="acts"><button type="button" class="btn-acc sm" data-fix="${esc(lead.id)}">How to fix →</button></div></section>`;
  }
  const html = `<div class="ai">${main}${fixFirst}</div>`;
  if (html !== lastAiHtml) { $("tab-ai").innerHTML = html; lastAiHtml = html; }
}
$("tab-ai").addEventListener("click", (e) => {
  const f = e.target.closest("[data-fix]"), ef = e.target.closest("[data-errfix]");
  if (f) openFix(f.dataset.fix);
  if (ef) {
    const x = analysis().topErrors.find((e) => e.code === ef.dataset.errfix);
    openFix(null, { topic: "code", code: ef.dataset.errfix }, x ? `${shortName(x.station)} · ${x.code}` : ef.dataset.errfix);
  }
});

let panelKey = null;
function renderPanels(force) {
  const an = analysis();
  renderTop(an);
  if (curTab === "now") renderNow();
  const key = AN_KEY + "|" + sim.date;
  if (!force && key === panelKey) return;
  panelKey = key;
  if (curTab === "loss") renderLoss(an);
  if (curTab === "ai") renderAI(an);
  if (tv.open) renderTable(an);
  renderIssues(an);
}

// ============================================================ station panel (focus)
let lastCardHtml = "";
function renderCard() {
  if (!focus) return;
  const st = focus, an = analysis();
  const evs = an.downs.filter((d) => d.station === st.name);
  const byCode = {};
  for (const d of evs) { const b = (byCode[d.code] = byCode[d.code] || { n: 0, min: 0, cause: d.cause_en }); b.n++; b.min += d.known; }
  const nokBy = {};
  for (const n of an.noks.filter((x) => x.station === st.name)) { const b = (nokBy[n.code] = nokBy[n.code] || { qty: 0, cause: n.cause_en }); b.qty += n.qty; }
  const pats = an.patterns.filter((p) => p.station === st.name);
  const s = st.state, ev = st.reason;
  const other = ev && L01.byName[ev.station] ? shortName(ev.station) : "";
  const statusTxt = {
    run: ["Running", "Cycle in order"],
    pause: ["Planned pause", "Maintenance or break"],
    fault: ["Stopped · " + (ev ? ev.code : ""), ev ? `${ev.cause_en} · since ${fmtHM(SHIFT_START_S + ev.s)}` : ""],
    blocked: ["Waiting", ev ? `Blocked: ${other} (${ev.code}) downstream is stopped` : ""],
    starved: ["Waiting", ev ? `No pallets: ${other} (${ev.code}) upstream stopped the flow` : ""],
  }[s];
  const fixCode = st.code && byCode[st.code] ? st.code : Object.keys(byCode)[0] || Object.keys(nokBy)[0] || null;
  const html = `<div class="hd"><div><b>${esc(longName(st.name))}</b><small>STAGE ${esc(st.stage)}${st.code ? " · " + esc(st.code) : ""}</small></div><button type="button" class="x" id="card-back" aria-label="Back to line (Esc)">×</button></div>
    <div class="blk"><div class="blk-h">Status at ${fmtHM(SHIFT_START_S + sim.t)}</div>
      <div class="state ${s}"><span class="sq"></span><div><b>${esc(statusTxt[0])}</b><small>${esc(statusTxt[1])}</small></div></div></div>
    <div class="blk"><div class="blk-h">Stops · month to date</div>
    ${Object.keys(byCode).length ? Object.entries(byCode).map(([code, b]) => `<div class="ev"><code>${esc(code)}</code><span>${b.n} stop${b.n > 1 ? "s" : ""}${pats.some((p) => p.code === code) ? '<span class="flag"><span class="dia"></span>repeats</span>' : ""}</span><span class="m">${Math.round(b.min)}<small>min</small></span><span class="why">${esc(b.cause)}</span></div>`).join("") : '<div class="note">No stops recorded here so far.</div>'}
    ${pats.map((p) => `<div class="note"><b>${p.level === "confirmed" ? "Every" : "Watch:"} ${WEEKDAYS_LONG[p.wd]} ${p.hhmm}</b> · ${p.hits} of ${p.opp} past ${WEEKDAYS_LONG[p.wd]}s</div>`).join("")}</div>
    <div class="blk"><div class="blk-h">Defects · month to date</div>
    ${Object.keys(nokBy).length ? Object.entries(nokBy).map(([code, b]) => `<div class="ev"><code>${esc(code)}</code><span>${esc(b.cause)}</span><span class="m">${b.qty}<small>pcs</small></span></div>`).join("") : '<div class="note">No defects mapped here so far.</div>'}
    <div class="note">Code → station mapping is our assumption.</div></div>
    <div class="card-btns">${fixCode ? `<button type="button" class="btn-acc sm" data-fixcode="${esc(fixCode)}">How to fix →</button>` : ""}</div>`;
  if (html !== lastCardHtml) { $("card").innerHTML = html; lastCardHtml = html; }
}
$("card").addEventListener("click", (e) => {
  if (e.target.closest("#card-back")) unfocus();
  const f = e.target.closest("[data-fixcode]");
  if (f) openFix(null, { topic: "code", code: f.dataset.fixcode }, `${longName(focus.name)} · ${f.dataset.fixcode}`);
});

// ============================================================ table view
const tv = { open: false, table: "shifts", sort: {}, hidden: {}, issuesOpen: false };
const NUM = (v, d = 0) => (isFinite(v) ? v.toFixed(d) : "—");
const TABLES = {
  shifts: {
    label: "Shifts", sort: ["oee", 1],
    cols: [
      { k: "date", h: "SHIFT", l: true, key: true, v: (r) => r.sortDate, f: (r) => fmtDate(r.date) },
      { k: "oee", h: "OEE", key: true, v: (r) => r.k.OEE, f: (r) => pct(r.k.OEE) },
      { k: "good", h: "GOOD", v: (r) => r.good, f: (r) => r.good },
      { k: "nok", h: "NOK", v: (r) => r.nok, f: (r) => r.nok },
      { k: "stop", h: "STOPPED, MIN", v: (r) => r.m.stopped, f: (r) => r.m.stopped },
      { k: "slow", h: "SLOW, MIN", v: (r) => r.m.slow, f: (r) => r.m.slow },
      { k: "plan", h: "PLANNED, MIN", opt: true, v: (r) => r.m.plan, f: (r) => r.m.plan },
      { k: "a", h: "AVAIL.", opt: true, v: (r) => r.k.A, f: (r) => pct(r.k.A) },
      { k: "p", h: "PERF.", opt: true, v: (r) => r.k.P, f: (r) => pct(r.k.P) },
      { k: "q", h: "QUALITY", opt: true, v: (r) => r.k.Q, f: (r) => pct(r.k.Q) },
    ],
    rows: (an) => an.days.map((x) => {
      const k = kpis(x.c), m = wholeMinutes(x.c);
      return { date: x.date, sortDate: dayNo(x.date), m, k, good: m.good, nok: m.prod - m.good, cur: !x.done, bad: k.OEE < DATA.meta.target_oee };
    }),
  },
  hours: {
    label: "Hours", sort: ["date", -1],
    cols: [
      { k: "date", h: "SHIFT", l: true, key: true, v: (r) => r.sortAbs, f: (r) => fmtDate(r.date) },
      { k: "hour", h: "HOUR", l: true, v: (r) => r.hour, f: (r) => `${pad2(5 + r.hour)}–${pad2(6 + r.hour)}` },
      { k: "oee", h: "OEE", key: true, v: (r) => r.k.OEE, f: (r) => pct(r.k.OEE) },
      { k: "prod", h: "MADE", v: (r) => r.prod, f: (r) => r.prod },
      { k: "nok", h: "NOK", v: (r) => r.nok, f: (r) => r.nok },
      { k: "stop", h: "STOPPED, MIN", v: (r) => r.c.down, f: (r) => fl(r.c.down) },
      { k: "slow", h: "SLOW, MIN", v: (r) => r.slow, f: (r) => NUM(r.slow, 1) },
      { k: "plan", h: "PLANNED, MIN", opt: true, v: (r) => r.c.plan, f: (r) => fl(r.c.plan) },
      { k: "a", h: "AVAIL.", opt: true, v: (r) => r.k.A, f: (r) => pct(r.k.A) },
      { k: "p", h: "PERF.", opt: true, v: (r) => r.k.P, f: (r) => pct(r.k.P) },
      { k: "q", h: "QUALITY", opt: true, v: (r) => r.k.Q, f: (r) => pct(r.k.Q) },
    ],
    rows: (an) => {
      const out = [];
      for (const x of an.days) for (let h = 1; h <= 8; h++) {
        const s0 = (h - 1) * 3600;
        if (s0 >= x.t) break;
        const c = diffCum(sampleCum(DAYS[x.date], s0), sampleCum(DAYS[x.date], Math.min(x.t, s0 + 3600)));
        const k = kpis(c), prod = fl(c.produced);
        out.push({ date: x.date, hour: h, sortAbs: abs(x.date, s0), c, k, prod, nok: prod - fl(c.ok), slow: Math.max(0, c.run - c.produced), cur: x.t < s0 + 3600, bad: c.plan > 0 && k.OEE < DATA.meta.target_oee });
      }
      return out;
    },
  },
  stops: {
    label: "Stops", sort: ["date", -1],
    cols: [
      { k: "date", h: "SHIFT", l: true, key: true, v: (r) => r.sAbs, f: (r) => fmtDate(r.date) },
      { k: "from", h: "FROM", l: true, v: (r) => r.sAbs, f: (r) => r.from.slice(11) },
      { k: "to", h: "TO", l: true, v: (r) => r.eAbs, f: (r) => (r.ongoing ? "ongoing" : r.to.slice(11)) },
      { k: "min", h: "MIN", v: (r) => r.known, f: (r) => Math.round(r.known) },
      { k: "code", h: "CODE", l: true, v: (r) => r.code, f: (r) => `<code>${esc(r.code)}</code>`, html: true },
      { k: "st", h: "STATION", l: true, v: (r) => shortName(r.station), f: (r) => shortName(r.station) },
      { k: "cause", h: "CAUSE", l: true, txt: true, opt: true, on: true, v: (r) => r.cause_en, f: (r) => r.cause_en },
    ],
    rows: (an) => { const rec = new Set(an.patterns.flatMap((p) => p.events.map((e) => e.code + e.from))); return an.downs.map((d) => ({ ...d, bad: rec.has(d.code + d.from), cur: d.ongoing })); },
  },
  defects: {
    label: "Defects", sort: ["date", -1],
    cols: [
      { k: "date", h: "SHIFT", l: true, key: true, v: (r) => r.sAbs, f: (r) => fmtDate(r.date) },
      { k: "hour", h: "HOUR", l: true, v: (r) => r.sAbs, f: (r) => r.hourLabel },
      { k: "code", h: "CODE", l: true, v: (r) => r.code, f: (r) => `<code>${esc(r.code)}</code>`, html: true },
      { k: "qty", h: "PCS", v: (r) => r.qty, f: (r) => r.qty },
      { k: "st", h: "STATION", l: true, v: (r) => shortName(r.station), f: (r) => shortName(r.station) },
      { k: "cause", h: "CAUSE", l: true, txt: true, opt: true, on: true, v: (r) => r.cause_en, f: (r) => r.cause_en },
    ],
    rows: (an) => an.noks.map((n) => { const h = HOUR_BY_ID.get(n.hour_id); return { ...n, sAbs: abs(h.date, isoToSec(h.from)), hourLabel: `${h.from.slice(11, 13)}–${h.to.slice(11, 13)}` }; }),
  },
};
let HOUR_BY_ID = new Map();
function colsOf(id) {
  const hid = tv.hidden[id] || (tv.hidden[id] = new Set(TABLES[id].cols.filter((c) => c.opt && !c.on).map((c) => c.k)));
  return TABLES[id].cols.filter((c) => !hid.has(c.k));
}
function renderTable(an) {
  const T = TABLES[tv.table];
  $("tv-tabs").innerHTML = Object.entries(TABLES).map(([id, t]) => `<button type="button" data-t="${id}" class="${id === tv.table ? "on" : ""}">${t.label} <span>${t.rows(an).length}</span></button>`).join("");
  const [sk, sd] = tv.sort[tv.table] || T.sort;
  const cols = colsOf(tv.table), sc = T.cols.find((c) => c.k === sk);
  const rows = T.rows(an).slice().sort((a, b) => {
    const x = sc.v(a), y = sc.v(b);
    if (typeof x === "string") return x.localeCompare(y) * sd;
    return ((isFinite(x) ? x : -Infinity) - (isFinite(y) ? y : -Infinity)) * sd;
  });
  $("tv-table").innerHTML = `<thead><tr>${cols.map((c) => `<th scope="col" data-k="${c.k}" class="${c.l ? "l" : ""}${c.k === sk ? " on" : ""}" aria-sort="${c.k === sk ? (sd > 0 ? "ascending" : "descending") : "none"}">${c.h}${c.k === sk ? (sd > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.bad ? "bad" : ""}${r.cur ? " cur" : ""}">${cols.map((c, i) => {
      const v = c.html ? c.f(r) : esc(c.f(r));
      const cls = [c.l ? "l" : "", c.txt ? "txt" : "", !c.l && !c.txt ? "num" : "", c.key ? "key" : ""].filter(Boolean).join(" ");
      return `<td class="${cls}">${i === 0 ? (r.bad ? '<span class="dia"></span>' : '<span class="sp"></span>') : ""}${v}</td>`;
    }).join("")}</tr>`).join("")}</tbody>`;
  $("tv-empty").classList.toggle("hidden", rows.length > 0);
  $("tv-empty").textContent = rows.length ? "" : "Nothing recorded before now.";
}
function renderIssues(an) {
  const n = an.issues.length;
  $("issues-count").textContent = n;
  $("issues-count").classList.toggle("zero", !n);
  if (!tv.open) return;
  const html = `<div class="hd"><b>Issues</b><span>most OEE first</span></div>
    ${n ? `<ul>${an.issues.map((x) => `<li><div class="t"><span class="dia${x.kind === "pattern" ? (x.level === "watch" ? " w" : "") : " o"}"></span>${esc(x.title)}</div>
      <div class="m">${Math.round(x.value)} ${x.unit}</div>
      <div class="s"><code>${esc(x.code)}</code>${esc(x.sub)} · +${x.pts.toFixed(1)} pts</div>
      <button type="button" class="btn-acc sm" data-fix="${esc(x.id)}">How to fix →</button></li>`).join("")}</ul>` : '<div class="empty">No issues before now.</div>'}`;
  if ($("issues-in").innerHTML !== html) $("issues-in").innerHTML = html;
}
function setIssues(open) {
  tv.issuesOpen = open;
  $("issues-wrap").classList.toggle("closed", !open);
  $("issues-btn").setAttribute("aria-expanded", open);
  $("issues-btn").setAttribute("aria-label", open ? "Hide issues" : "Show issues");
}
// Metrics: every column but the row name can be switched off; the main ones start on, extras start off.
function renderMetrics() {
  const T = TABLES[tv.table], hid = tv.hidden[tv.table];
  const box = (c) => `<label><input type="checkbox" data-col="${c.k}" ${hid.has(c.k) ? "" : "checked"}>${c.h}</label>`;
  const main = T.cols.slice(1).filter((c) => !c.opt), extra = T.cols.slice(1).filter((c) => c.opt);
  $("tv-metrics").innerHTML = `<div class="h">COLUMNS</div>${main.map(box).join("")}${extra.length ? `<div class="h">EXTRA</div>${extra.map(box).join("")}` : ""}`;
}
function setMetrics(open) {
  if (open) renderMetrics();
  $("tv-metrics").classList.toggle("open", open);
  $("tv-metrics-btn").setAttribute("aria-expanded", open);
}
// Line <-> table: the header stays, the dark panel grows into the table (View Transitions; plain switch where not supported).
function openTables(on) {
  if (on === tv.open) return;
  const swap = () => {
    tv.open = on;
    document.body.classList.toggle("tables", on);
    $("btn-table").textContent = on ? "← LINE VIEW" : "TABLE VIEW →";
    setMetrics(false);
    if (on) { if (focus) unfocus(); setIssues(false); colsOf(tv.table); renderTable(analysis()); renderIssues(analysis()); }
    else { layout(); if (!VIEW_2D && renderer) render3D(performance.now(), 0); }
  };
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(swap);
  else swap();
}
$("btn-table").addEventListener("click", () => openTables(!tv.open));
$("tv-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-t]"); if (b) { tv.table = b.dataset.t; colsOf(tv.table); renderTable(analysis()); if ($("tv-metrics").classList.contains("open")) renderMetrics(); } });
$("tv-table").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-k]");
  if (!th) return;
  const [sk, sd] = tv.sort[tv.table] || TABLES[tv.table].sort;
  tv.sort[tv.table] = [th.dataset.k, th.dataset.k === sk ? -sd : th.dataset.k === "oee" ? 1 : -1];
  renderTable(analysis());
});
$("tv-metrics-btn").addEventListener("click", () => setMetrics(!$("tv-metrics").classList.contains("open")));
document.addEventListener("pointerdown", (e) => { if ($("tv-metrics").classList.contains("open") && !e.target.closest(".tv-metrics")) setMetrics(false); });
$("tv-metrics").addEventListener("change", (e) => {
  const k = e.target.dataset.col;
  if (!k) return;
  const hid = tv.hidden[tv.table];
  if (e.target.checked) hid.delete(k); else hid.add(k);
  renderTable(analysis());
});
$("issues-btn").addEventListener("click", () => setIssues(!tv.issuesOpen));
$("issues-in").addEventListener("click", (e) => { const f = e.target.closest("[data-fix]"); if (f) openFix(f.dataset.fix); });

// ============================================================ How to fix (Claude through our server, rule text as fallback)
let fixSeq = 0;
function asOfIso() {
  // next whole minute, so a stop that started this minute is included (server keeps events with start < asOf)
  const m = Math.floor(nowAbs() / 60) + 1, sec = m * 60 - dayNo(sim.date) * 86400;
  return sim.date + "T" + fmtHM(sec);
}
async function openFix(issueId, topicArg, titleArg) {
  const an = analysis();
  const x = issueId ? an.issues.find((i) => i.id === issueId) : null;
  const topic = topicArg || (x && x.topic);
  if (!topic) return;
  const title = titleArg || (x ? `${x.title}${x.code && x.code !== "Speed" ? " · " + x.code : ""}` : "How to fix");
  const ruleKey = topic.topic === "restart" ? "restart" : topic.code;
  const rule = FIX[ruleKey] || ["Check the station against its work instruction.", "Call the shift leader if it repeats."];
  const asOf = asOfIso(), clockNow = fmtHM(SHIFT_START_S + sim.t);
  const facts = x && x.pattern ? `${x.pattern.hits} of ${x.pattern.opp} past ${WEEKDAYS_LONG[x.pattern.wd]}s at ${x.pattern.hhmm}` : x ? `${Math.round(x.value)} ${x.unit} this month` : "";
  const seq = ++fixSeq;
  $("fix-title").textContent = title;
  $("fix").classList.add("open");
  $("fix-close").focus();
  const show = (o) => {
    if (seq !== fixSeq) return;
    $("fix-body").innerHTML = `<div class="src">${esc(o.src)}</div>${o.why ? `<div class="why"><b>Likely cause:</b> ${esc(o.why)}</div>` : ""}
      ${o.steps ? `<ol>${o.steps.map((s) => `<li><span>${esc(s)}</span></li>`).join("")}</ol>` : ""}${o.wait ? '<div class="wait">Asking Claude…</div>' : ""}
      ${o.err ? `<div class="err">${esc(o.err)}</div>` : ""}<div class="facts">Data up to ${esc(fmtDate(sim.date) + " " + clockNow)}${facts ? " · " + esc(facts) : ""}. Later shifts are not sent.</div>`;
  };
  if (!CONFIG.ai) { show({ src: "RULE-BASED · CLAUDE OFF (NO API KEY ON THE SERVER)", steps: rule }); return; }
  show({ src: "CLAUDE", wait: true });
  try {
    const r = await fetch("/api/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...topic, asOf }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    show({ src: "WRITTEN BY CLAUDE" + (j.cached ? " · CACHED" : ""), why: j.why, steps: j.steps && j.steps.length ? j.steps : rule });
  } catch (err) {
    show({ src: "RULE-BASED", steps: rule, err: "Claude did not answer: " + err.message });
  }
}
function closeFix() { fixSeq++; $("fix").classList.remove("open"); }
$("fix-close").addEventListener("click", closeFix);
$("fix").addEventListener("click", (e) => { if (e.target === $("fix")) closeFix(); });

// ============================================================ controls
function setSpeed(v) { sim.speed = v; $("speed").value = String(v); }
function syncPlay() { $("btn-play").textContent = sim.playing ? "Pause" : "Play"; }
$("speed").addEventListener("change", (e) => setSpeed(Number(e.target.value)));
$("btn-play").addEventListener("click", () => { sim.playing = !sim.playing; syncPlay(); });
$("shift-select").addEventListener("change", (e) => setDate(e.target.value, 0));
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.key === "Escape") {
    if ($("fix").classList.contains("open")) closeFix();
    else if ($("tv-metrics").classList.contains("open")) setMetrics(false);
    else if (focus) unfocus();
    else if (tv.open) openTables(false);
  }
  if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); sim.playing = !sim.playing; syncPlay(); }
  if (e.key === "ArrowRight") { if (e.shiftKey) moveAlongConveyor(track.pitch); else seek(sim.t + 300); }
  if (e.key === "ArrowLeft") { if (e.shiftKey) moveAlongConveyor(-track.pitch); else seek(sim.t - 300); }
});

// keep fixed overlays clear of the header and footer
function layout() {
  const top = $("top").offsetHeight, bottom = $("bottom").offsetHeight;
  $("card").style.top = top + 8 + "px";
  $("card").style.bottom = bottom + 8 + "px";
  $("toasts").style.bottom = bottom + 48 + "px";
  $("stopped").style.top = VIEW_2D ? "" : top + 16 + "px";
  refit();
}

// ============================================================ main loop
let lastT = performance.now(), slowTick = 0;
function frame(now) {
  const rawDt = Math.max(0, (now - lastT) / 1000), dt = Math.min(0.1, rawDt);
  lastT = now;
  if (sim.playing) {
    sim.t += Math.min(1, rawDt) * sim.speed;
    if (sim.t >= SHIFT_LEN_S) {
      const i = DATES.indexOf(sim.date);
      if (i < DATES.length - 1) setDate(DATES[i + 1], 0); else { sim.t = SHIFT_LEN_S - 1; sim.playing = false; syncPlay(); }
    }
  }
  const act = activeSet(DAYS[sim.date], sim.t);
  if (sim.playing) for (const k of act) if (!lastActive.has(k)) {
    const ev = DAYS[sim.date].downs.find((d) => d.code + d.s === k);
    toast(`${shortName(ev.station)} stopped · ${fmtHM(SHIFT_START_S + ev.s)} · ${ev.code}`, "bad");
  }
  lastActive = act;

  blink = Math.floor(now / 400) % 2 === 0;
  labelsCompact = !focus && !!fitView && view.h > lineH * 0.6;
  const states = stationStates(DAYS[sim.date], sim.t);
  updateStations(dt, states);
  if (!VIEW_2D && !tv.open) render3D(now, dt);

  if (now - slowTick > 200) {
    slowTick = now;
    renderStopped(states);
    renderPanels(false);
    if (focus) renderCard();
  }
  requestAnimationFrame(frame);
}
function render3D(now, dt) {
  stepAnim(now);
  applyView();
  hazeMat.opacity += ((focus ? 0.55 : 0) - hazeMat.opacity) * Math.min(1, dt * 8);
  renderer.clear();
  camera.layers.set(0);
  renderer.shadowMap.autoUpdate = true;
  renderer.render(scene, camera);
  if (hazeMat.opacity > 0.01) {
    renderer.render(hazeScene, hazeCam);
    if (focus) {
      renderer.clearDepth();
      camera.layers.set(1);
      renderer.shadowMap.autoUpdate = false;
      renderer.render(scene, camera);
      camera.layers.set(0);
    }
  }
  placeLabels();
}

function resize() {
  layout();
  if (VIEW_2D || !renderer) return;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (L01.root) {
    const wasFit = fitView && Math.abs(view.h - fitView.h) < 1e-6;
    computeFit();
    if (wasFit || !view.h) Object.assign(view, fitView);
    clampView();
  }
}
window.addEventListener("resize", resize);

// ============================================================ boot
async function boot() {
  try {
    $("ld-msg").textContent = "data";
    const [r, cfg] = await Promise.all([fetch("/api/data"), fetch("/api/config").then((x) => (x.ok ? x.json() : null)).catch(() => null)]);
    if (!r.ok) throw new Error("data.json: HTTP " + r.status);
    DATA = await r.json();
    if (cfg) CONFIG = cfg;
    const q = new URLSearchParams(location.search).get("view");
    VIEW_2D = q === "2d" ? true : q === "3d" ? false : CONFIG.view === "2d";
    DATES = DATA.shifts.map((s) => s.date).sort();
    HOUR_TO = new Map(DATA.hours.map((h) => [h.id, abs(h.date, isoToSec(h.to))]));
    HOUR_BY_ID = new Map(DATA.hours.map((h) => [h.id, h]));
    for (const d of DATES) DAYS[d] = buildDay(d);
    // shift list shows dates only: a shift's OEE is not known before it runs
    $("shift-select").innerHTML = DATES.map((d) => `<option value="${d}">${fmtDate(d).toUpperCase()}</option>`).join("");

    if (!VIEW_2D) {
      try { init3D(); await loadModel(); }
      catch (err) {
        console.error(err);
        VIEW_2D = true;
        toast("3D view could not start: " + (err.message || err) + ". Showing 2D.", "bad");
      }
    }
    if (VIEW_2D) build2D();
    buildNow();
    layout();
    if (!VIEW_2D) {
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      computeFit();
      Object.assign(view, fitView);
    }
    // start: today's shift if it is in the data, else the first Wednesday; a few minutes before its first stop
    const today = new Date(), iso = today.getFullYear() + "-" + pad2(today.getMonth() + 1) + "-" + pad2(today.getDate());
    const start = DAYS[iso] ? iso : DATES.find((d) => weekday(d) === 3) || DATES[0];
    const first = DAYS[start].downs[0];
    setDate(start, first ? Math.max(0, first.s - 180) : 0);
    setSpeed(60); syncPlay();
    setTab("now");
    if (new URLSearchParams(location.search).has("debug")) window.__oee = { L01, sim, lineClock, analysis };   // for checks in the console
    $("loading").remove();
    requestAnimationFrame((t) => { lastT = t; frame(t); });
  } catch (err) {
    console.error(err);
    $("loading").classList.add("err");
    $("loading").querySelector("em").textContent = "Could not start";
    $("ld-msg").textContent = String(err.message || err) + (location.protocol === "file:" ? " · open via node server.js, not by double-click" : "");
  }
}
boot();
