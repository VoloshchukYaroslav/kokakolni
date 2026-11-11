// OEE Improvement Engine: 3D view + bottom panel (stage 1)
// Data: /api/data (built from the xlsx), model: /model/line_L01_stations.glb
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

// ============================================================ constants
const MODEL_URL = "/model/line_L01_stations.glb";
const SHIFT_START_S = 6 * 3600;           // 06:00
const SHIFT_LEN_S = 8 * 3600;             // 8 h
const BLOCK_HOLD_S = 215 / 24;            // blocked stations wait at frame 215
const GREY_LINES = [];   // other lines removed from the view; add names here to bring back grey "not connected" lines
const CAM_YAW = THREE.MathUtils.degToRad(0);    // front view: line runs left -> right
const CAM_EL = THREE.MathUtils.degToRad(24);    // looking slightly down
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// English station names (model extras are in Russian)
const STATION_EN = {
  "Lift_In": "Pallet lift in", "ST-001": "Housing load", "Station_02": "Motor insertion",
  "ST-016": "Vision check · motor", "Station_04": "Motor screws #1 (manual)", "ST-017": "Motor screws #2 (auto)",
  "Station_06": "Turn 90°", "Station_07": "Inverter insertion", "ST-038": "Vision check #2",
  "Station_08": "Inverter screws", "ST-046": "Leak test A", "ST-047": "Leak test B + reject",
  "Station_10": "Transfer to EOL", "Lift_Out": "Pallet lift out",
};

// Short plain names the operator uses on the floor (tags, status, toasts)
const STATION_SHORT = {
  "Lift_In": "Lift in", "ST-001": "Load", "Station_02": "Motor in", "ST-016": "Camera 1", "Station_04": "Screws 1",
  "ST-017": "Screws 2", "Station_06": "Turn", "Station_07": "Inverter in", "ST-038": "Camera 2", "Station_08": "Inv. screws",
  "ST-046": "Leak test A", "ST-047": "Leak test B", "Station_10": "To EOL", "Lift_Out": "Lift out",
};
const shortName = (name) => STATION_SHORT[name] || name;

// Countermeasures shown with patterns / codes. Rule-based for now; Claude API comes in stage 3.
const FIX = {
  "ST-038": "Same weekly slot every time → look for a weekly trigger (cleaning, handover, scheduled job). Check light-module power and connector; swap the module before Wed 09:00.",
  "ST-047": "Fixture seal leaks every Thursday morning → inspect/replace the test-bed seal in Wednesday PM maintenance; add a leak self-test at shift start.",
  "ST-046": "Leak unit interrupts tests → check hoses and fittings, verify unit with a reference part at shift start.",
  "ST-016": "Vision station stops → check camera link and power, clean lens, verify lighting.",
  "ST-001": "Part not ready at station → kanban trigger for housings, supply check 10 min before the hour.",
  "ST-017": "Tool sequence stops → read tool error log, check bit wear and torque controller.",
  "restart": "Standardise restart: pre-stage parts and run a warm-up cycle before the break ends; stagger breaks so the line never restarts cold.",
  "weekday": "Wednesday is the only day below target. Fix the Wednesday ST-038 slot first; then compare Wednesday staffing and maintenance plan.",
};

// ============================================================ helpers
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pad2 = (n) => String(n).padStart(2, "0");
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "–");
const fmtHM = (secOfDay) => pad2(Math.floor(secOfDay / 3600) % 24) + ":" + pad2(Math.floor(secOfDay / 60) % 60);
const isoToSec = (iso) => { const t = iso.split("T")[1]; const [h, m] = t.split(":").map(Number); return h * 3600 + m * 60; };
const dateObj = (d) => new Date(d + "T00:00:00");
const weekday = (d) => dateObj(d).getDay();
const fmtDate = (d) => { const o = dateObj(d); return WEEKDAYS[o.getDay()] + " " + pad2(o.getDate()) + " " + o.toLocaleString("en-GB", { month: "short" }) + " " + o.getFullYear(); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtIn(sec) {
  if (sec < 60) return "now";
  const m = Math.round(sec / 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return "in " + (d ? d + " d " : "") + (d || h ? h + " h " : "") + (d ? "" : mm + " min");
}
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ============================================================ data model
let DATA = null;
const DAYS = {};      // date -> per-shift model
let DATES = [];       // ordered shift dates

function buildDay(date) {
  const hours = DATA.hours.filter((h) => h.date === date).sort((a, b) => a.hour - b.hour);
  const shift = DATA.shifts.find((s) => s.date === date);
  const downs = DATA.downtimes.filter((d) => d.date === date).map((d) => ({
    ...d, s: isoToSec(d.from) - SHIFT_START_S, e: isoToSec(d.to) - SHIFT_START_S,
  })).sort((a, b) => a.s - b.s);

  // minute status: 0 run, 1 planned pause, 2 downtime
  const status = new Uint8Array(480);
  for (const h of hours) {
    const base = (h.hour - 1) * 60;
    for (let i = 0; i < (h.am_min || 0) + (h.pause_min || 0); i++) status[base + i] = 1;
  }
  for (const d of downs) {
    for (let m = Math.floor(d.s / 60); m < Math.ceil(d.e / 60); m++) if (status[m] === 0) status[m] = 2;
  }
  // distribute each hour's totals evenly over its running minutes -> cumulative arrays
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
  return { date, hours, shift, downs, status, cum };
}

function sampleCum(day, t) {
  const m = clamp(Math.floor(t / 60), 0, 479), f = clamp((t - m * 60) / 60, 0, 1), o = {};
  for (const k in day.cum) { const a = day.cum[k]; o[k] = a[m] + (a[m + 1] - a[m]) * f; }
  return o;
}

function kpis(c) {
  const A = c.plan ? c.run / c.plan : NaN, P = c.run ? c.produced / c.run : NaN, Q = c.produced ? c.ok / c.produced : NaN;
  return { A, P, Q, OEE: A * P * Q };
}

// ---------- pattern engine (rule-based, transparent) ----------
let PATTERNS = [];
let INSIGHTS = [];

function analyse() {
  const wdCount = {};
  for (const d of DATES) wdCount[weekday(d)] = (wdCount[weekday(d)] || 0) + 1;

  // 1) recurring downtime: same code, same weekday, same start time in >= 75% of those weekdays (min 3)
  const groups = {};
  for (const d of DATA.downtimes) {
    const k = d.code + "|" + weekday(d.date) + "|" + d.from.split("T")[1];
    (groups[k] = groups[k] || []).push(d);
  }
  PATTERNS = Object.entries(groups).filter(([k, ev]) => {
    const wd = Number(k.split("|")[1]);
    return ev.length >= 3 && ev.length / wdCount[wd] >= 0.75;
  }).map(([k, ev]) => {
    const [code, wd, hhmm] = k.split("|");
    const min = ev.reduce((s, e) => s + e.min, 0);
    return { type: "recurring", code, wd: Number(wd), hhmm, startSec: isoToSec("x T" + hhmm) - SHIFT_START_S,
      count: ev.length, of: wdCount[wd], min, avg: Math.round(min / ev.length), station: ev[0].station,
      cause: ev[0].cause_en, dates: ev.map((e) => e.date) };
  }).sort((a, b) => b.min - a.min);

  const M = DATA.month, PQ = M.P * M.Q;
  const gainPP = (min) => (min * PQ / M.plan_min) * 100;

  INSIGHTS = PATTERNS.map((p) => ({
    kind: "Recurring failure", code: p.code, station: p.station,
    head: `${p.code} fails every ${WEEKDAYS_LONG[p.wd]} at ${p.hhmm}`,
    ev: `${p.count} of ${p.of} ${WEEKDAYS_LONG[p.wd]}s · ${p.avg} min each · ${p.cause}`,
    gain: `Fix it: +${p.min} min/month · +${gainPP(p.min).toFixed(1)} pp OEE`,
    fix: FIX[p.code] || "", pattern: p,
  }));

  // 2) restart losses after planned pauses (hours with AM / break)
  const byHour = {};
  for (const h of DATA.hours) {
    const b = (byHour[h.hour] = byHour[h.hour] || { run: 0, prod: 0, pause: 0 });
    b.run += h.run_min; b.prod += h.produced; b.pause += (h.am_min || 0) + (h.pause_min || 0);
  }
  const pauseHours = Object.keys(byHour).filter((h) => byHour[h].pause > 0).map(Number);
  const others = Object.keys(byHour).filter((h) => byHour[h].pause === 0);
  const Pref = others.reduce((s, h) => s + byHour[h].prod, 0) / others.reduce((s, h) => s + byHour[h].run, 0);
  let restartMin = 0;
  const parts = pauseHours.map((h) => {
    const P = byHour[h].prod / byHour[h].run;
    restartMin += Math.max(0, (Pref - P) * byHour[h].run);
    return `hour ${h}: ${pct(P)}`;
  });
  if (restartMin > 20) INSIGHTS.push({
    kind: "Speed loss", code: null,
    head: "Line runs slow after every planned pause",
    ev: `Performance ${parts.join(", ")} vs ${pct(Pref)} in other hours`,
    gain: `Fix it: +${Math.round(restartMin)} min/month · +${gainPP(restartMin).toFixed(1)} pp OEE`,
    fix: FIX.restart,
  });

  // 3) weekday below target
  const below = DATA.shifts.filter((s) => s.OEE < DATA.meta.target_oee);
  const wds = [...new Set(below.map((s) => weekday(s.date)))];
  if (below.length && wds.length === 1) {
    const wd = wds[0], same = DATA.shifts.filter((s) => weekday(s.date) === wd), rest = DATA.shifts.filter((s) => weekday(s.date) !== wd);
    const avg = (a) => a.reduce((s, x) => s + x.OEE, 0) / a.length;
    INSIGHTS.push({
      kind: "Day pattern", code: null,
      head: `All ${below.length} shifts below target were ${WEEKDAYS_LONG[wd]}s`,
      ev: `${WEEKDAYS_LONG[wd]} OEE ${pct(avg(same))} vs ${pct(avg(rest))} other days`,
      gain: `Target ${pct(DATA.meta.target_oee, 0)} · worst ${fmtDate(below.sort((a, b) => a.OEE - b.OEE)[0].date)}`,
      fix: FIX.weekday, worstDate: below[0].date,
    });
  }
}

// next predicted occurrence of any recurring pattern after (date, t)
function nextPrediction(date, t) {
  let best = null;
  const now = dateObj(date).getTime() / 1000 + SHIFT_START_S + t;
  for (const p of PATTERNS) {
    for (let i = 0; i <= 14; i++) {
      const d = dateObj(date); d.setDate(d.getDate() + i);
      if (d.getDay() !== p.wd) continue;
      const at = d.getTime() / 1000 + SHIFT_START_S + p.startSec;
      if (at > now) { if (!best || at < best.at) best = { p, at, date: d, inSec: at - now }; break; }
    }
  }
  return best;
}

// ============================================================ three.js scene
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the warm paper tones (ACES turns them grey)
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.autoClear = false;

const scene = new THREE.Scene();
// No scene.background on purpose: a Color background force-clears on every render() call,
// which would wipe pass 1 when the focused station is drawn in pass 2. We clear manually instead.
renderer.setClearColor(0xe7e8e8, 1);

const hemi = new THREE.HemisphereLight(0xffffff, 0xc4c8cb, 1.5);
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(hemi, sun, sun.target);
for (const l of [hemi, sun]) l.layers.enable(1);   // lights also light the focus pass

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
const camTarget = new THREE.Vector3();
const camDir = new THREE.Vector3(-Math.sin(CAM_YAW) * Math.cos(CAM_EL), Math.sin(CAM_EL), Math.cos(CAM_YAW) * Math.cos(CAM_EL));
const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();

// haze overlay used for the focus mode ("fog" over everything else)
const hazeScene = new THREE.Scene();
const hazeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const hazeMat = new THREE.MeshBasicMaterial({ color: 0xe7e8e8, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
hazeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hazeMat));

// ---------- procedural "white lab" textures ----------
function tileTexture(size, tiles, base, seam, jitter) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), s = size / tiles;
  for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) {
    const v = jitter ? Math.round((Math.sin(x * 12.9 + y * 78.2) * 43758.5 % 1) * jitter) : 0;
    g.fillStyle = `rgb(${base[0] + v},${base[1] + v},${base[2] + v})`;
    g.fillRect(x * s, y * s, s, s);
  }
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
function wallTexture() {
  const c = document.createElement("canvas"); c.width = 512; c.height = 1024;
  const g = c.getContext("2d");
  g.fillStyle = "#f3f0e9"; g.fillRect(0, 0, 512, 1024);
  g.strokeStyle = "#d6d2c8"; g.lineWidth = 3;
  for (let y = 0; y <= 1024; y += 256) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  for (let x = 0; x <= 512; x += 256) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 1024); g.stroke(); }
  g.fillStyle = "#1a1a1a"; g.fillRect(0, 1004, 512, 4);              // thin charcoal rule at the foot of the wall
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
  return t;
}

// ============================================================ model
const L01 = { root: null, mixer: null, stations: [], byName: {}, meshes: [] };
const greyLines = [];        // { name, root, anchor }
let contentBox = new THREE.Box3();
let lineSpacing = 8;

async function loadModel() {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL, (e) => {
    if (e.total) $("ld-msg").textContent = Math.round((e.loaded / e.total) * 100) + "% of model";
  });
  const root = gltf.scene;
  root.name = "L01";
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  lineSpacing = Math.max(8, size.z + 6);           // wide gaps so lines do not overlap in the front view

  // stations = direct children that carry a "stage" extra; order along X = process order
  const roots = root.children.filter((c) => c.userData && c.userData.stage !== undefined);
  roots.sort((a, b) => a.position.x - b.position.x);
  L01.mixer = new THREE.AnimationMixer(root);
  roots.forEach((r, i) => {
    let prefix = null;
    r.traverse((o) => { if (!prefix && /_Andon_G$/.test(o.name)) prefix = o.name.replace(/_Andon_G$/, ""); });
    const lamps = {};
    for (const k of ["G", "Y", "R"]) {
      const m = r.getObjectByName(prefix + "_Andon_" + k);
      if (m && m.material) {
        const mat = m.material;
        mat.userData.base = mat.color.clone();
        mat.userData.on = mat.color.clone().multiplyScalar(1.0);
        lamps[k] = mat;
      }
    }
    const actions = gltf.animations.filter((a) => a.name.startsWith(prefix + "_")).map((clip) => {
      const a = L01.mixer.clipAction(clip); a.play(); return a;
    });
    const dur = actions.length ? Math.max(...actions.map((a) => a.getClip().duration)) : 10;
    const sbox = new THREE.Box3().setFromObject(r);
    const st = {
      name: r.name, idx: i, root: r, prefix, lamps, actions, dur, t: 0, parked: false,
      pallet: r.getObjectByName(prefix + "_Pallet"), box: sbox,
      stage: String(r.userData.stage) === "lift_in" ? "IN" : String(r.userData.stage) === "lift_out" ? "OUT" : String(r.userData.stage), code: r.userData.st_code && r.userData.st_code !== "-" ? r.userData.st_code : null,
      mechanism: r.userData.mechanism, en: STATION_EN[r.name] || r.name, state: "run", reason: null, label: null,
    };
    r.traverse((o) => { if (o.isMesh) { o.userData.station = st.name; L01.meshes.push(o); } });
    L01.stations.push(st);
    L01.byName[st.name] = st;
  });
  L01.root = root;
  scene.add(root);

  // three grey "not connected" lines behind L01
  const greyMat = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.9, metalness: 0 });
  GREY_LINES.forEach((name, i) => {
    const g = SkeletonUtils.clone(root);
    g.name = name;
    g.position.z = -(i + 1) * lineSpacing;
    g.traverse((o) => { if (o.isMesh) { o.material = greyMat; o.userData = { greyLine: name }; } });
    scene.add(g);
    greyLines.push({ name, root: g });
  });

  // floor and walls
  scene.updateMatrixWorld(true);
  contentBox = new THREE.Box3();
  contentBox.expandByObject(root);
  for (const g of greyLines) contentBox.expandByObject(g.root);
  const c = contentBox.getCenter(new THREE.Vector3()), s = contentBox.getSize(new THREE.Vector3());
  const floorTex = tileTexture(1024, 8, [231, 232, 232], "#d0d3d5", 0);
  const floorW = 220, floorD = 220;
  floorTex.repeat.set(floorW / 16, floorD / 16);           // 2 m tiles
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(c.x, contentBox.min.y - 0.01, c.z);
  floor.receiveShadow = true;
  scene.add(floor);

  const wallH = 9, wt = wallTexture();
  const backLen = s.x + 24, sideLen = s.z + 18;
  const mkWall = (len) => {
    const t = wt.clone(); t.needsUpdate = true; t.repeat.set(len / 4.5, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, wallH), new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
    m.receiveShadow = true; return m;
  };
  const back = mkWall(backLen);
  back.position.set(c.x + 4, contentBox.min.y + wallH / 2, contentBox.min.z - 6);
  const side = mkWall(sideLen);
  side.rotation.y = -Math.PI / 2;
  side.position.set(contentBox.max.x + 10, contentBox.min.y + wallH / 2, c.z - 3);
  // walls removed: the line stands on open paper (editorial look)

  // sun covers the whole content box
  sun.position.set(c.x - 25, 40, c.z + 30);
  sun.target.position.copy(c);
  const sc = sun.shadow.camera, r = Math.max(s.x, s.z) * 0.75 + 10;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 1; sc.far = 140;
  sc.updateProjectionMatrix();

  // camera orientation: fixed angle, never rotates
  camTarget.copy(c);
  camera.position.copy(camTarget).addScaledVector(camDir, 300);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  camUp.setFromMatrixColumn(camera.matrixWorld, 1);
  camera.near = 1; camera.far = 700;

  buildLabels();
}

// ============================================================ camera (pan + zoom only)
const view = { cx: 0, cy: 0, h: 10 };      // centre in view-plane metres, half height
let fitView = null, contentRect = null, anim = null;

const toView = (p) => { const d = p.clone().sub(camTarget); return { x: d.dot(camRight), y: d.dot(camUp) }; };
function rectOfBox(box) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const v = toView(p);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}
// screen space taken by UI on top / bottom (px) -> keep content in the free band
function insets() {
  const H = window.innerHeight;
  const top = $("top").offsetHeight + 4;
  const bottom = $("bottom").offsetHeight + 8;
  const right = focus ? $("card").offsetWidth + 40 : 0;
  return { top, bottom, right, H, W: window.innerWidth };
}
function computeFit() {
  // Fit the line width to the screen; put L01 at the bottom of the free band.
  // Grey lines may run up behind the top bar: they are background.
  contentRect = rectOfBox(contentBox);
  const main = rectOfBox(new THREE.Box3().setFromObject(L01.root));
  const { top, bottom, H, W } = insets();
  const aspect = W / H, free = 1 - (top + bottom) / H;
  const h = Math.max(main.w / (2 * aspect) * 1.04, main.h / (2 * free) * 1.1);
  fitView = { cx: main.cx, cy: greyLines.length ? Math.min(main.minY - h * 0.06 + h * free, contentRect.maxY) : main.cy, h };
}
function applyView() {
  const { top, bottom, right, H, W } = insets();
  const aspect = W / H;
  const c = (bottom - top) / H;                       // shift so (cx,cy) sits in the middle of the free band
  const cr = right / W;
  const mx = view.cx + view.h * aspect * cr, my = view.cy - view.h * c;
  camera.left = mx - view.h * aspect; camera.right = mx + view.h * aspect;
  camera.top = my + view.h; camera.bottom = my - view.h;
  camera.updateProjectionMatrix();
}
function clampView() {
  if (!fitView) return;
  view.h = clamp(view.h, fitView.h * 0.14, fitView.h * 1.15);
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

// pointer: drag = pan, wheel = zoom to cursor, click = select
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) { drag.moved = true; canvas.classList.add("grab"); }
    if (drag.moved && !focus) {
      anim = null;
      const H = window.innerHeight;
      view.cx -= dx * (2 * view.h / H); view.cy += dy * (2 * view.h / H);
      clampView();
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
  if (focus || !fitView) return;
  anim = null;
  const W = window.innerWidth, H = window.innerHeight, aspect = W / H;
  // keep the point under the cursor fixed
  const nx = (e.clientX / W) * 2 - 1, ny = -(e.clientY / H) * 2 + 1;
  const wx = (camera.left + camera.right) / 2 + nx * view.h * aspect, wy = (camera.top + camera.bottom) / 2 + ny * view.h;
  const offX = (camera.left + camera.right) / 2 - view.cx, offY = (camera.top + camera.bottom) / 2 - view.cy;
  const nh = clamp(view.h * Math.exp(e.deltaY * 0.0012), fitView.h * 0.14, fitView.h * 1.15);
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
let focus = null, hovered = null;

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
    canvas.classList.toggle("hover", !!(u && (u.station || u.greyLine)));
  });
}
function clickAt(x, y) {
  const u = pick(x, y);
  if (!u) { if (focus) unfocus(); return; }
  if (u.greyLine) { toast(`${u.greyLine} is not connected yet: no data source.`); return; }
  if (u.station) focusStation(u.station);
}

function setLayer1(obj, on) { obj.traverse((o) => (on ? o.layers.enable(1) : o.layers.disable(1))); }

function focusStation(name) {
  const st = L01.byName[name];
  if (!st) return;
  if (focus && focus !== st) setLayer1(focus.root, false);
  if (!focus) $("card").dataset.prev = JSON.stringify(view);
  focus = st;
  setLayer1(st.root, true);
  $("card").classList.remove("hidden");
  renderCard();
  const r = rectOfBox(st.box);
  const { top, bottom, right, H, W } = insets();
  const aspect = W / H, free = 1 - (top + bottom) / H, freeW = 1 - right / W;
  const h = Math.max(r.h / (2 * free), r.w / (2 * aspect * freeW)) * 1.8;   // generous margin around the station
  animateView({ cx: r.cx, cy: r.cy, h });
  document.body.classList.add("focus");
}
function unfocus() {
  if (!focus) return;
  setLayer1(focus.root, false);
  focus = null;
  $("card").classList.add("hidden");
  let prev = null;
  try { prev = JSON.parse($("card").dataset.prev || "null"); } catch (e) { prev = null; }
  animateView(prev || fitView);
  document.body.classList.remove("focus");
}

// ============================================================ labels over stations
function buildLabels() {
  const host = $("labels");
  for (const st of L01.stations) {
    const el = document.createElement("div");
    el.className = "lbl run";
    el.innerHTML = `<span class="dot"></span><span>${esc(shortName(st.name))}</span><span class="nm">${esc(st.code || "")}</span>`;
    el.title = `${st.en}${st.code ? " · " + st.code : ""}`;
    el.addEventListener("click", () => focusStation(st.name));
    el.addEventListener("mouseenter", () => { hovered = st.name; });
    el.addEventListener("mouseleave", () => { if (hovered === st.name) hovered = null; });
    host.appendChild(el);
    st.label = el;
    st.anchor = new THREE.Vector3((st.box.min.x + st.box.max.x) / 2, st.box.max.y + 0.15, (st.box.min.z + st.box.max.z) / 2);
  }
  for (const g of greyLines) {
    const el = document.createElement("div");
    el.className = "lbl grey";
    el.textContent = `${g.name} · not connected`;
    el.addEventListener("click", () => toast(`${g.name} is not connected yet: no data source.`));
    host.appendChild(el);
    const b = new THREE.Box3().setFromObject(g.root);
    g.label = el;
    g.anchor = new THREE.Vector3(b.min.x + 1, b.max.y + 0.2, (b.min.z + b.max.z) / 2);
  }
  pickables = [...L01.meshes];
  for (const g of greyLines) g.root.traverse((o) => { if (o.isMesh) pickables.push(o); });
}
const tmpV = new THREE.Vector3();
function placeLabels() {
  const W = window.innerWidth, H = window.innerHeight;
  const put = (el, v, show) => {
    if (!show) { el.style.display = "none"; return; }
    tmpV.copy(v).project(camera);
    const x = (tmpV.x + 1) / 2 * W, y = (1 - tmpV.y) / 2 * H;
    el.style.display = x < -50 || x > W + 50 || y < 0 || y > H ? "none" : "";
    el.style.left = x + "px"; el.style.top = y + "px";
  };
  for (const st of L01.stations) put(st.label, st.anchor, !focus || focus === st);
  for (const g of greyLines) put(g.label, g.anchor, !focus);
}

// ============================================================ simulation
const sim = { date: null, t: 0, playing: true, speed: 60, live: false };
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
      for (let j = 0; j < k; j++) set(j, "blocked", ev);          // upstream: queue fills, stations wait
    }
    for (let j = k + 1; j < n; j++) {                              // downstream: starve one cycle later each
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

function updateStations(dt, states) {
  const rate = sim.playing ? (sim.speed <= 1 ? 1 / 6 : sim.speed >= 600 ? 2 : 1) : 0;
  states.forEach((s, i) => {
    const st = L01.stations[i];
    st.state = s.state; st.reason = s.reason;
    if (s.state !== "starved") st.parked = false;
    switch (s.state) {
      case "run":
        st.t = (st.t + dt * rate) % st.dur; break;
      case "blocked": {
        const nt = st.t + dt * rate;
        if (st.t <= BLOCK_HOLD_S && nt >= BLOCK_HOLD_S) st.t = BLOCK_HOLD_S;
        else st.t = nt % st.dur;
        break;
      }
      case "starved":
        if (!st.parked) { st.t += dt * rate; if (st.t >= st.dur) { st.t = 0; st.parked = true; } }
        break;
      default: break;                                              // fault / pause: freeze
    }
    if (st.pallet) st.pallet.visible = !st.parked;
    for (const a of st.actions) a.time = st.t;
    setLamp(st, s.state === "run" ? "G" : s.state === "fault" ? "R" : s.state === "pause" ? null : "Y");
    const cls = "lbl " + s.state + (hovered === st.name ? " hl" : "");
    if (st.label.className !== cls) st.label.className = cls;
  });
  L01.mixer.update(0);
}

function seek(t) { sim.t = clamp(t, 0, SHIFT_LEN_S - 1); lastActive = activeSet(DAYS[sim.date], sim.t); }
function activeSet(day, t) { return new Set(day.downs.filter((d) => t >= d.s && t < d.e).map((d) => d.code + d.s)); }

function setDate(d, t) {
  sim.date = d;
  $("shift-select").value = d;
  $("date-label").textContent = fmtDate(d);
  buildTimeline();
  seek(t === undefined ? sim.t : t);
  renderLoss();
  if (focus) renderCard();
}

// ============================================================ timeline
function buildTimeline() {
  const day = DAYS[sim.date], tr = $("tl-track");
  const pctOf = (s) => (s / SHIFT_LEN_S) * 100;
  let html = "";
  for (let h = 1; h < 8; h++) html += `<div class="hr" style="left:${pctOf(h * 3600)}%"></div>`;
  // pauses
  let m = 0;
  while (m < 480) {
    if (day.status[m] === 1) { const s = m; while (m < 480 && day.status[m] === 1) m++; html += `<div class="seg-pause" style="left:${pctOf(s * 60)}%;width:${pctOf((m - s) * 60)}%" title="Planned pause ${fmtHM(SHIFT_START_S + s * 60)}–${fmtHM(SHIFT_START_S + m * 60)}"></div>`; }
    else m++;
  }
  const recCodes = new Set(PATTERNS.filter((p) => p.wd === weekday(sim.date)).map((p) => p.code + "|" + p.hhmm));
  for (const d of day.downs) {
    const rec = recCodes.has(d.code + "|" + d.from.split("T")[1]);
    html += `<div class="seg-down${rec ? " rec" : ""}" style="left:${pctOf(d.s)}%;width:${pctOf(d.e - d.s)}%" title="${esc(d.code)} · ${esc(d.cause_en)} · ${fmtHM(SHIFT_START_S + d.s)}–${fmtHM(SHIFT_START_S + d.e)} (${d.min} min)${rec ? " · recurring" : ""}"></div>`;
  }
  for (const h of day.hours) if (h.nok) {
    html += `<div class="nok" style="left:${pctOf((h.hour - 1) * 3600) + 0.4}%;width:${Math.min(11.5, h.nok * 1.6)}%" title="${h.nok} NOK in hour ${h.hour}"></div>`;
  }
  tr.innerHTML = html;
  $("tl-axis").innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((h) => `<span style="left:${pctOf(h * 3600)}%">${pad2(6 + h)}:00</span>`).join("");
}
(() => {
  const tl = $("timeline");
  let dragging = false;
  const go = (e) => { const r = tl.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * SHIFT_LEN_S); };
  tl.addEventListener("pointerdown", (e) => { dragging = true; tl.setPointerCapture(e.pointerId); go(e); });
  tl.addEventListener("pointermove", (e) => dragging && go(e));
  tl.addEventListener("pointerup", () => (dragging = false));
})();

// ============================================================ bottom panel
function setTab(name) {
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const t of ["now", "loss", "ai"]) $("tab-" + t).classList.toggle("hidden", t !== name);
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });

function lineStatus(states) {
  const day = DAYS[sim.date], m = clamp(Math.floor(sim.t / 60), 0, 479);
  if (day.status[m] === 1) return { cls: "pause", t: "Planned pause", d: "AM / break · andons off" };
  // every station in fault, longest stop first (several can stop at once)
  const faults = states.map((s, i) => ({ s, st: L01.stations[i] })).filter((x) => x.s.state === "fault")
    .map((x) => ({ st: x.st, ev: x.s.reason, min: Math.max(0, Math.floor((sim.t - x.s.reason.s) / 60)) }))
    .sort((a, b) => b.min - a.min);
  if (faults.length) return { cls: "fault", t: "Line stopped", d: faults.length + (faults.length > 1 ? " stations" : " station"), faults, station: faults[0].st.name };
  const y = states.filter((s) => s.state !== "run").length;
  if (y) return { cls: "wait", t: "Recovering", d: `${y} station(s) still waiting after the last stop` };
  return { cls: "run", t: "Running", d: "All stations green" };
}

// Line icons drawn for this project (big grey glyph behind tile content)
const ICON = {
  gauge: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M14 68a36 36 0 1 1 72 0M23 68a27 27 0 1 1 54 0M50 68 67 42M14 68h9M77 68h9M50 32v-9"/><circle cx="50" cy="68" r="4"/></svg>',
  rates: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M10 84h80M20 84V54M40 84V34M60 84V46M80 84V22"/></svg>',
  box: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 14 84 30v40L50 86 16 70V30zM16 30l34 16 34-16M50 46v40M33 22l34 16"/></svg>',
  nok: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M20 20h60v60H20zM36 36l28 28M64 36 36 64"/></svg>',
  wrench: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M64 14a20 20 0 0 0-23 26L15 66l19 19 26-26a20 20 0 0 0 26-23L74 48l-13-4-4-13z"/></svg>',
  line: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M8 50h84v14H8zM18 64v20M82 64v20M28 50V32h18v18M56 50V36h14v14"/><circle cx="20" cy="57" r="3"/><circle cx="40" cy="57" r="3"/><circle cx="60" cy="57" r="3"/><circle cx="80" cy="57" r="3"/></svg>',
  chart: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M14 82h74M14 82V18M14 66l20-14 16 10 18-24 18 8"/></svg>',
  list: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M20 24h60M20 40h44M20 56h52M20 72h30"/></svg>',
  idea: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="42" r="22"/><path d="M40 72h20M42 82h16M44 62v10M56 62v10M50 28v14l8 6"/></svg>',
  station: '<svg class="ico" viewBox="0 0 100 100" aria-hidden="true"><path d="M16 20h68v60H16zM16 44h68M30 80V58h40v22M50 20v24"/></svg>',
};
const sec = (color, en, code) => `<div class="sec" style="--c:var(${color})"><span>${en}</span><span>${code}</span></div>`;
const tt = (sk, en) => `<div class="tt"><b>${sk}</b><small>${en}</small></div>`;

let lastNowHtml = "";
function renderNow(states) {
  const day = DAYS[sim.date], c = sampleCum(day, sim.t), k = kpis(c), tgt = DATA.meta.target_oee;
  const ls = lineStatus(states);
  const speedLoss = Math.max(0, c.run - c.produced);
  const nokNow = Math.floor(c.produced) - Math.floor(c.ok);
  const started = day.downs.filter((d) => d.s <= sim.t).length;
  const num = isFinite(k.OEE) ? (k.OEE * 100).toFixed(1) : "—";
  const delta = isFinite(k.OEE) ? `${k.OEE >= tgt ? "+" : "−"}${Math.abs((k.OEE - tgt) * 100).toFixed(1)} pp vs target` : "shift not started";
  const html = `<div class="now">
    <div class="tile">${sec("--s-shift", "Shift OEE", "Z-01")}<div class="body">
      <div class="top-row">${tt("Zmena", "OEE · this shift so far")}<span class="cnt">TGT <b>${pct(tgt, 0)}</b></span></div>
      <div class="num">${num}<span class="u">%</span></div><div class="sub-num">${esc(delta)}</div></div>${ICON.gauge}</div>
    <div class="tile">${sec("--s-shift", "Rates", "Z-02")}<div class="body rates">
      ${[["Dostupnosť", "Availability", k.A], ["Výkon", "Performance", k.P], ["Kvalita", "Quality", k.Q]].map(([sk, en, v]) =>
        `<div class="row"><div class="top">${tt(sk, en)}<span class="v">${pct(v)}</span></div><div class="meter"><i style="width:${isFinite(v) ? v * 100 : 0}%"></i></div></div>`).join("")}
      </div>${ICON.rates}</div>
    <div class="tile">${sec("--s-shift", "Output", "Z-03")}<div class="body">
      ${tt("Výroba", "Produced, pcs")}<div class="num mid">${Math.floor(c.produced)}</div><div class="sub-num">good <b>${Math.floor(c.ok)}</b></div></div>${ICON.box}</div>
    <div class="tile">${sec("--s-shift", "Quality", "Z-04")}<div class="body">
      <div class="top-row">${tt("NOK", "Defects, pcs")}<span class="cnt"><b>${nokNow}</b>/${DATA.month.nok}</span></div>
      <div class="num mid">${nokNow}</div><div class="sub-num">month total ${DATA.month.nok}</div></div>${ICON.nok}</div>
    <div class="tile">${sec("--s-shift", "Downtime", "Z-05")}<div class="body">
      <div class="top-row">${tt("Prestoje", "Downtime, min")}<span class="cnt"><b>${started}</b>/${day.downs.length}</span></div>
      <div class="num mid">${Math.round(c.down)}</div><div class="sub-num">speed loss <b>${Math.round(speedLoss)}</b> min</div></div>${ICON.wrench}</div>
    <div class="tile status-tile">${sec("--s-station", "Line status", "L-01")}<div class="body">
      ${tt("Linka L01", "Line status")}
      <div class="status-t ${ls.cls}">${ls.cls === "fault" ? '<span class="rh"></span>' : ""}${esc(ls.t)}${ls.faults ? `<span class="cnt">${esc(ls.d)}</span>` : ""}</div>
      ${ls.faults ? `<div class="frows">${ls.faults.slice(0, 3).map((f) => `<div class="frow"><span><b>${esc(shortName(f.st.name))}</b><code>${esc(f.ev.code)}</code></span><span class="min">${f.min} min</span><button class="go" data-focus="${esc(f.st.name)}">Show →</button></div>`).join("")}
        ${ls.faults.length > 3 ? `<div class="more">+${ls.faults.length - 3} more</div>` : ""}</div>` : `<div class="status-d">${esc(ls.d)}</div>`}</div>${ICON.line}</div>
  </div>`;
  if (html !== lastNowHtml) { $("tab-now").innerHTML = html; lastNowHtml = html; }
}
$("tab-now").addEventListener("click", (e) => { const b = e.target.closest("[data-focus]"); if (b) focusStation(b.dataset.focus); });

function lossParts(c) {
  // minutes: plan = good + quality + speed + downtime
  const quality = c.produced - c.ok, speed = Math.max(0, c.run - c.produced);
  return { good: c.ok, speed, down: c.down, quality, plan: c.plan };
}
function stackRow(name, p) {
  const seg = (v, cls, label) => `<i class="${cls}" style="width:${(v / p.plan) * 100}%" title="${label}: ${Math.round(v)} min"></i>`;
  return `<div class="lrow"><div class="nm">${name}</div><div class="stack">${seg(p.good, "c-good", "Good parts")}${seg(p.speed, "c-speed", "Speed loss")}${seg(p.down, "c-down", "Downtime")}${seg(p.quality, "c-q", "Quality loss")}</div>
    <div class="tot">${Math.round(p.plan - p.good)}<small>min lost</small></div></div>`;
}
function renderLoss() {
  const day = DAYS[sim.date], M = DATA.month;
  const shiftFull = lossParts(sampleCum(day, SHIFT_LEN_S - 0.001));
  const month = { good: M.ok, speed: M.run_min - M.produced, down: M.downtime_min, quality: M.nok, plan: M.plan_min };
  const top = {};
  for (const d of DATA.downtimes) top[d.code] = (top[d.code] || 0) + d.min;
  const pareto = Object.entries(top).sort((a, b) => b[1] - a[1]);
  const max = pareto[0][1];
  const codesTotal = DATA.codes.filter((c) => c.type === "Prestoj").length;
  const sk = { speed: "Spomalenie", downtime: "Prestoje", quality: "NOK" };
  const biggest = [["speed", month.speed], ["downtime", month.down], ["quality", month.quality]].sort((a, b) => b[1] - a[1])[0];
  $("tab-loss").innerHTML = `<div class="loss">
    <div class="tile">${sec("--s-loss", "Loss breakdown", "S-01")}<div class="body">
      <div class="top-row">${tt("Straty", "Where the planned minutes went")}<span class="cnt">PLAN <b>${M.plan_min}</b> min</span></div>
      ${stackRow(fmtDate(sim.date).slice(0, 10) + " · full shift", shiftFull)}
      ${stackRow("Month · 21 shifts", month)}
      <div class="legend"><span><i class="c-good"></i>Good parts</span><span><i class="c-speed"></i>Spomalenie · speed ${Math.round(month.speed)} min</span>
        <span><i class="c-down"></i>Prestoje · downtime ${month.down} min</span><span><i class="c-q"></i>NOK · quality ${month.quality} min</span></div>
      <div class="verdict">Largest loss: <span>${sk[biggest[0]]}</span>, ${Math.round(biggest[1])} min — not the breakdowns.</div>
    </div>${ICON.chart}</div>
    <div class="tile pareto">${sec("--s-loss", "Downtime by code", "S-02")}<div class="body">
      <div class="top-row">${tt("Prestoje", "Month · minutes per code")}<span class="cnt"><b>${pareto.length}</b>/${codesTotal}</span></div>
      ${pareto.map(([code, min]) => { const st = DATA.downtimes.find((d) => d.code === code).station;
        return `<div class="pr" data-focus="${esc(st)}" title="Show ${esc(code)} on the line"><code>${esc(code)}</code><div><div class="b" style="width:${(min / max) * 100}%"></div></div><div class="m">${min}</div></div>`; }).join("")}
    </div></div></div>`;
}
$("tab-loss").addEventListener("click", (e) => { const b = e.target.closest("[data-focus]"); if (b) focusStation(b.dataset.focus); });

// Insights: lead finding on the left, index of all findings on the right.
const KIND_SK = { "Recurring failure": "Opakovaná porucha", "Speed loss": "Spomalenie", "Day pattern": "Vzor dňa" };
let leadInsight = 0;
function renderAI() {
  const x = INSIGHTS[leadInsight];
  if (!x) { $("tab-ai").innerHTML = '<div class="src">No patterns found in this data.</div>'; return; }
  $("tab-ai").innerHTML = `<div class="ai">
    <div class="tile story">${sec("--s-ai", "Finding " + pad2(leadInsight + 1), "A-01")}<div class="body">
      ${tt(esc(KIND_SK[x.kind] || x.kind), esc(x.kind))}
      <h4>${x.pattern ? '<span class="rh"></span>' : ""}${esc(x.head)}</h4>
      <div class="e">${esc(x.ev)}</div>
      <div class="fix">${esc(x.fix)}</div>
      <div class="acts"><span class="gain">${esc(x.gain)}</span>
        ${x.pattern ? `<button class="go" data-replay="${leadInsight}">Replay it →</button><button class="go" data-focus="${esc(x.station)}">Show station →</button>` : ""}
        ${x.worstDate ? `<button class="go" data-date="${esc(x.worstDate)}">Open worst shift →</button>` : ""}</div>
    </div>${ICON.idea}</div>
    <div class="tile">${sec("--s-ai", "Findings index", "A-02")}<div class="body">
      <div class="top-row">${tt("Analýza", "Pattern engine · xlsx")}<span class="cnt"><b>${PATTERNS.length}</b>/${INSIGHTS.length}</span></div>
      <ol class="idx">${INSIGHTS.map((y, i) => `<li data-pick="${i}" class="${i === leadInsight ? "on" : ""}">
        <span class="no">${pad2(i + 1)}</span><span class="h">${y.pattern ? '<span class="rh"></span>' : ""}${esc(y.head)}</span><span class="gain">${esc((y.gain.match(/\+[\d.]+ pp OEE/) || [""])[0])}</span></li>`).join("")}</ol>
      <div class="src">Rule-based findings. Claude-written fixes arrive in stage 3.</div></div></div>
  </div>`;
}
$("tab-ai").addEventListener("click", (e) => {
  const r = e.target.closest("[data-replay]"), f = e.target.closest("[data-focus]"), d = e.target.closest("[data-date]"), p = e.target.closest("[data-pick]");
  if (r) {
    const pat = INSIGHTS[Number(r.dataset.replay)].pattern;
    const date = pat.dates.find((x) => x >= sim.date) || pat.dates[0];
    setDate(date, pat.startSec - 120); sim.playing = true; setSpeed(60); syncPlay();
    focusStation(pat.station);
  }
  if (f) focusStation(f.dataset.focus);
  if (d) setDate(d.dataset.date, 0);
  if (p) { leadInsight = Number(p.dataset.pick); renderAI(); }
});

// ============================================================ station tile (focus)
let lastCardHtml = "";
function renderCard() {
  if (!focus) return;
  const st = focus;
  const evs = DATA.downtimes.filter((d) => d.station === st.name);
  const nok = DATA.nok.filter((n) => n.station === st.name);
  const byCode = {};
  for (const d of evs) { const b = (byCode[d.code] = byCode[d.code] || { n: 0, min: 0, cause: d.cause_en }); b.n++; b.min += d.min; }
  const nokBy = {};
  for (const n of nok) { const b = (nokBy[n.code] = nokBy[n.code] || { qty: 0, cause: n.cause_en }); b.qty += n.qty; }
  const pats = PATTERNS.filter((p) => p.station === st.name);
  const s = st.state, ev = st.reason;
  const upName = ev && L01.byName[ev.station] ? L01.byName[ev.station].en : "";
  const statusTxt = {
    run: ["Running", "Cycle in order"],
    pause: ["Planned pause", "AM or break"],
    fault: ["Fault · " + (ev ? ev.code : ""), ev ? `${ev.cause_en} — since ${fmtHM(SHIFT_START_S + ev.s)}, ${ev.min} min` : ""],
    blocked: ["Blocked", ev ? `Waiting for ${ev.code} downstream (${upName})` : ""],
    starved: ["Starved", ev ? `No pallets: ${ev.code} upstream (${upName}) stopped the flow` : ""],
  }[s];
  const html = `${sec("--s-station", "Station · stage " + esc(st.stage), esc(st.code || "—"))}
    <div class="head">${tt(esc(st.en), esc((st.code || "no monitored code") + " · " + (st.mechanism || "")))}</div>
    <div class="blk"><div class="blk-h"><b>Stav</b>Status at ${fmtHM(SHIFT_START_S + sim.t)}</div>
      <div class="state ${s}"><span class="sq"></span><div><b>${esc(statusTxt[0])}</b><small>${esc(statusTxt[1])}</small></div></div></div>
    <div class="blk"><div class="blk-h"><b>Prestoje</b>Downtime this month</div>
    ${Object.keys(byCode).length ? Object.entries(byCode).map(([code, b]) => `<div class="ev"><code>${esc(code)}</code><span>${b.n} stops${pats.some((p) => p.code === code) ? '<span class="flag"><span class="rh"></span>recurring</span>' : ""}</span><span class="m">${b.min}<small>min</small></span><span class="why">${esc(b.cause)}</span></div>`).join("") : '<div class="note">No downtime recorded for this station.</div>'}
    ${pats.map((p) => `<div class="pattern"><b>Every ${WEEKDAYS_LONG[p.wd]} ${p.hhmm} · ${p.count}/${p.of}</b>${esc(FIX[p.code] || "")}</div>`).join("")}</div>
    <div class="blk"><div class="blk-h"><b>NOK</b>Defects detected here</div>
    ${Object.keys(nokBy).length ? Object.entries(nokBy).map(([code, b]) => `<div class="ev"><code>${esc(code)}</code><span>${esc(b.cause)}</span><span class="m">${b.qty}<small>pcs</small></span></div>`).join("") : '<div class="note">No defects mapped to this station.</div>'}
    <div class="note">Code → station mapping is our assumption.</div></div>
    <div class="card-btns"><button class="go" disabled title="Stage 3: Claude API">How to fix · AI</button><button class="go" id="card-back">Back to line · Esc</button></div>
    ${ICON.station}`;
  if (html !== lastCardHtml) { $("card").innerHTML = html; lastCardHtml = html; }
}
$("card").addEventListener("click", (e) => { if (e.target.closest("#card-back")) unfocus(); });

// ============================================================ time controls
function setSpeed(v) {
  sim.speed = v;
  for (const b of $("speed").children) b.classList.toggle("on", Number(b.dataset.speed) === v);
}
function syncPlay() { $("btn-play").textContent = sim.playing ? "Pause" : "Play"; }
$("speed").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSpeed(Number(b.dataset.speed)); });
$("btn-play").addEventListener("click", () => { sim.playing = !sim.playing; syncPlay(); });
$("shift-select").addEventListener("change", (e) => setDate(e.target.value));
$("btn-table").addEventListener("click", () => toast("Table view arrives in stage 2."));
$("predict").addEventListener("click", () => {
  const n = nextPrediction(sim.date, sim.t);
  if (!n) return;
  const iso = n.date.getFullYear() + "-" + pad2(n.date.getMonth() + 1) + "-" + pad2(n.date.getDate());
  if (DAYS[iso]) { setDate(iso, n.p.startSec - 120); setSpeed(60); sim.playing = true; syncPlay(); }
  focusStation(n.p.station);
});
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT") return;
  if (e.key === "Escape") unfocus();
  if (e.key === " ") { e.preventDefault(); sim.playing = !sim.playing; syncPlay(); }
  if (e.key === "ArrowRight") seek(sim.t + 300);
  if (e.key === "ArrowLeft") seek(sim.t - 300);
});

function renderTop() {
  $("clock").textContent = fmtHM(SHIFT_START_S + sim.t);
  const day = DAYS[sim.date];
  $("fr-shift").textContent = pad2(DATES.indexOf(sim.date) + 1) + "/" + DATES.length;
  $("fr-evt").textContent = day.downs.filter((d) => d.s <= sim.t).length + "/" + day.downs.length;
  $("tl-head").style.left = (sim.t / SHIFT_LEN_S) * 100 + "%";
  const n = nextPrediction(sim.date, sim.t), el = $("predict");
  if (n) {
    el.classList.remove("hidden");
    const html = `<span class="rh"></span><span class="k">Prognóza</span><b>${esc(n.p.code)}</b><span>${WEEKDAYS[n.p.wd]} ${n.p.hhmm}</span><span class="cd">${fmtIn(n.inSec)}</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
  } else el.classList.add("hidden");
}

// ============================================================ main loop
let lastT = performance.now(), slowTick = 0;
function frame(now) {
  const rawDt = Math.max(0, (now - lastT) / 1000);
  const dt = Math.min(0.1, rawDt);                   // for animation (avoid jumps)
  lastT = now;

  if (sim.playing) {
    sim.t += Math.min(1, rawDt) * sim.speed;          // sim clock follows real time even at low FPS
    if (sim.t >= SHIFT_LEN_S) {                     // next shift
      const i = DATES.indexOf(sim.date);
      if (i < DATES.length - 1) setDate(DATES[i + 1], 0); else { sim.t = SHIFT_LEN_S - 1; sim.playing = false; syncPlay(); }
    }
  }
  // fault start toasts (only while playing forward)
  const act = activeSet(DAYS[sim.date], sim.t);
  if (sim.playing) for (const k of act) if (!lastActive.has(k)) {
    const ev = DAYS[sim.date].downs.find((d) => d.code + d.s === k);
    toast(`${shortName(ev.station)} stopped · ${fmtHM(SHIFT_START_S + ev.s)} · ${ev.code}`, "bad");
  }
  lastActive = act;

  blink = Math.floor(now / 400) % 2 === 0;
  const states = stationStates(DAYS[sim.date], sim.t);
  updateStations(dt, states);

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

  if (now - slowTick > 200) {                         // UI text 5×/s is enough
    slowTick = now;
    renderTop();
    renderNow(states);
    if (focus) renderCard();
  }
  requestAnimationFrame(frame);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (contentRect || L01.root) {
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
    const r = await fetch("/api/data");
    if (!r.ok) throw new Error("data.json: HTTP " + r.status);
    DATA = await r.json();
    DATES = DATA.shifts.map((s) => s.date).sort();
    for (const d of DATES) DAYS[d] = buildDay(d);
    analyse();

    $("shift-select").innerHTML = DATES.map((d) => {
      const s = DATA.shifts.find((x) => x.date === d), low = s.OEE < DATA.meta.target_oee;
      return `<option value="${d}">${fmtDate(d).slice(0, 10)} · OEE ${pct(s.OEE)}${low ? " · below target" : ""}</option>`;
    }).join("");

    await loadModel();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    computeFit();
    Object.assign(view, fitView);

    // start: today's shift if it is in the data, otherwise the first Wednesday; a few minutes before its first stop
    const today = new Date(), iso = today.getFullYear() + "-" + pad2(today.getMonth() + 1) + "-" + pad2(today.getDate());
    const start = DAYS[iso] ? iso : DATES.find((d) => weekday(d) === 3) || DATES[0];
    const first = DAYS[start].downs[0];
    setDate(start, first ? Math.max(0, first.s - 180) : 0);
    setSpeed(60); syncPlay();
    renderAI();
    setTab("now");
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
