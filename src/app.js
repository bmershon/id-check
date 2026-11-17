import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import WASM_B64 from "../build/zxing_reader.wasm.b64";
import { initOCR, ocrImage, parseMRZ, ocrFields } from "./ocr.js";

// ---------- setup ----------
globalThis.pdfjsWorker = pdfWorker; // run pdf.js in main thread (no worker file needed)
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
prepareZXingModule({ overrides: { wasmBinary: b64ToBytes(WASM_B64).buffer } });

const FORMATS = ["PDF417", "QRCode", "DataMatrix", "Aztec", "Code128", "Code39"];
const $ = (s) => document.querySelector(s);

// ---------- state (memory only; nothing persisted) ----------
let trip = null; // {id, legs:[{n, route, pax:[...]}]}
let legIdx = 0;
let lastScanText = "";
let lastScanAt = 0;

// ---------- helpers ----------
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 5000);
}
const norm = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const toks = (s) => norm(s).split(" ").filter(Boolean);
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => (d ? `${d.m}/${d.d}/${d.y}` : "—");
const sameDate = (a, b) => a && b && a.y === b.y && a.m === b.m && a.d === b.d;
function yy2yyyy(yy) {
  const n = parseInt(yy, 10);
  if (yy.length === 4) return n;
  const cur = new Date().getFullYear() % 100;
  return n > cur ? 1900 + n : 2000 + n;
}
const G = (g) => {
  g = (g || "").toString().trim().toLowerCase();
  if (g === "1" || g.startsWith("m")) return "M";
  if (g === "2" || g.startsWith("f")) return "F";
  if (g === "9" || g === "x" || g.startsWith("u") || g.startsWith("n")) return "X";
  return "";
};

// ---------- manifest parsing ----------
async function pdfToLines(buf) {
  const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // group items into rows: items whose baselines are within ~5pt share a row
    const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
    items.sort((a, b) => b.y - a.y);
    const rows = [];
    for (const it of items) {
      const r = rows.find((r) => Math.abs(r.y - it.y) < 5);
      if (r) r.c.push(it); else rows.push({ y: it.y, c: [it] });
    }
    rows.sort((a, b) => b.y - a.y).forEach((r) => lines.push(r.c.sort((a, b) => a.x - b.x).map((c) => c.s).join("   ")));
  }
  return lines;
}

const PAX_RE =
  /([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'.\- ]+?)\s*\(\s*(Male|Female|Unspecified|Undisclosed|X)\s*[-–—]\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*\)/g;

function parseManifest(lines) {
  const text = lines.join("\n");
  const idm = text.match(/Crew Itinerary\s*\(([A-Z0-9]+)\)/) || text.match(/\(([A-Z0-9]{5,8})\)/);
  const legs = [];
  let cur = null;
  const ensureLeg = (n, route) => {
    let l = legs.find((x) => x.n === n);
    if (!l) {
      l = { n, route: route || "", expected: null, pax: [] };
      legs.push(l);
    }
    if (route && !l.route) l.route = route;
    return l;
  };
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    let m = s.match(/\bLeg\s+(\d+)\s*:\s*([A-Z0-9]{3,4})[^A-Za-z0-9]+([A-Z0-9]{3,4})\b/);
    if (m) { cur = ensureLeg(+m[1], `${m[2]} → ${m[3]}`); continue; }
    m = s.match(/\bLeg\s+(\d+)\s*:\s*Pax:\s*(\d+)/);
    if (m) { const l = ensureLeg(+m[1]); l.expected = +m[2]; }
    m = s.match(/\bPax\s*\((\d+)\)/);
    if (m && cur && cur.expected == null) cur.expected = +m[1];
    PAX_RE.lastIndex = 0;
    let pm;
    while ((pm = PAX_RE.exec(s))) {
      if (!cur) cur = ensureLeg(1);
      const name = pm[1].replace(/^Pax\s*\(\d+\)\s*/, "").trim();
      const t = name.split(/\s+/);
      cur.pax.push({
        name,
        first: t[0],
        last: t[t.length - 1],
        middle: t.slice(1, -1).join(" "),
        gender: G(pm[2]),
        dob: { m: +pm[3], d: +pm[4], y: yy2yyyy(pm[5]) },
        primary: /Primary/i.test(s.slice(pm.index + pm[0].length, pm.index + pm[0].length + 12)),
        status: "pending", // pending | boarded | flagged
        how: "",
        note: "",
      });
    }
  }
  legs.forEach((l) => {
    l.pax.sort((a, b) => norm(a.last).localeCompare(norm(b.last)) || norm(a.first).localeCompare(norm(b.first)));
    if (l.expected == null) l.expected = l.pax.length;
  });
  return { id: idm ? idm[1] : "", legs: legs.filter((l) => l.pax.length) };
}

function parsePasted(text) {
  return parseManifest(text.split(/\r?\n/));
}

// ---------- ID / badge parsing ----------
function parseAAMVA(raw) {
  raw = raw.replace(/<LF>/g, "\n").replace(/<CR>/g, "\r").replace(/<RS>/g, "\x1e").replace(/<GS>/g, "\x1d");
  if (!/ANSI |AAMVA|\bDAQ|\bDCS|\bDAA/.test(raw)) return null;
  const f = {};
  for (let line of raw.split(/[\n\r\x1e\x1d]+/)) {
    // header line: "ANSI 636000090002DL00410278ZV03190008DLDAQ…" — drop the header and the
    // subfile directory (2 letters + 8 digits each), keeping only the first data element.
    // Only touch the header so names like MIDDLETON / SIDDIQUI are never split.
    line = line.replace(/^.*?(?:ANSI|AAMVA)\s*\d+(?:[A-Z]{2}\d{8})*/, "");
    // a subfile that starts its own line: "DLDAQ…", "IDDCS…"
    line = line.replace(/^(?:DL|ID)(?=D[A-Z]{2})/, "");
    const m = line.match(/^(D[A-Z]{2}|Z[A-Z]{2})(.*)$/);
    if (m && !(m[1] in f)) f[m[1]] = m[2].trim();
  }
  let last = f.DCS || f.DAB || "", first = f.DAC || f.DCT || "", middle = f.DAD || "";
  if (!last && f.DAA) {
    const p = f.DAA.split(/[,$]/);
    last = p[0] || ""; first = p[1] || ""; middle = p.slice(2).join(" ");
  }
  if (f.DCT && !f.DAC) { const p = f.DCT.split(/[ ,]/); first = p[0]; middle = middle || p.slice(1).join(" "); }
  const date = (v) => {
    if (!v || v.length < 8) return null;
    if (/^(19|20)\d{2}/.test(v) && +v.slice(4, 6) <= 12) return { y: +v.slice(0, 4), m: +v.slice(4, 6), d: +v.slice(6, 8) };
    return { m: +v.slice(0, 2), d: +v.slice(2, 4), y: +v.slice(4, 8) };
  };
  const exp = date(f.DBA);
  const today = new Date();
  const expired = exp ? new Date(exp.y, exp.m - 1, exp.d, 23, 59) < today : false;
  return {
    kind: "Driver license / state ID",
    first, middle, last,
    dob: date(f.DBB),
    gender: G(f.DBC),
    exp, expired,
    realId: f.DDA === "F" ? "Yes" : f.DDA === "N" ? "No" : "Not encoded",
    state: f.DAJ || "",
    idLast4: (f.DAQ || "").slice(-4),
  };
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
function findDates(s) {
  const out = [];
  let m;
  const re1 = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g;
  while ((m = re1.exec(s))) out.push({ m: +m[1], d: +m[2], y: yy2yyyy(m[3]) });
  const re2 = /\b((?:19|20)\d{2})[\/\-.]?(\d{2})[\/\-.]?(\d{2})\b/g;
  while ((m = re2.exec(s))) if (+m[2] <= 12) out.push({ y: +m[1], m: +m[2], d: +m[3] });
  const re3 = /\b(\d{1,2})\s*([A-Za-z]{3})[a-z]*\s*(\d{4})\b/g;
  while ((m = re3.exec(s))) { const i = MONTHS.indexOf(m[2].toLowerCase()); if (i >= 0) out.push({ d: +m[1], m: i + 1, y: +m[3] }); }
  const re4 = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  while ((m = re4.exec(s))) { const i = MONTHS.indexOf(m[1].toLowerCase()); if (i >= 0) out.push({ d: +m[2], m: i + 1, y: +m[3] }); }
  return out.filter((d) => d.m >= 1 && d.m <= 12 && d.d >= 1 && d.d <= 31);
}

function parseGeneric(raw) {
  // badge / anything else: pull tokens + dates out of free text, JSON, vCard, key=value
  let text = raw;
  try { const j = JSON.parse(raw); text = Object.values(j).join(" "); } catch {}
  const vc = raw.match(/^N:([^;\n]*);([^;\n]*);?([^;\n]*)/m);
  return {
    kind: "Badge / other barcode",
    first: vc ? vc[2] : "", middle: vc ? vc[3] : "", last: vc ? vc[1] : "",
    tokens: toks(text),
    dates: findDates(raw),
    gender: "",
    raw,
  };
}

function ocrToId(text, barcodeId) {
  const mrz = parseMRZ(text);
  if (mrz) return { ...mrz, ocr: true };
  const { fixed, gender } = ocrFields(text);
  const id = { kind: "ID front / badge (text read)", first: "", middle: "", last: "", tokens: toks(fixed), dates: findDates(fixed), gender, raw: text, ocr: true };
  if (barcodeId) {
    id.kind = "Badge (barcode + printed name)";
    id.tokens = [...barcodeId.tokens, ...id.tokens];
    id.dates = [...barcodeId.dates, ...id.dates];
    id.raw = barcodeId.raw + "\n---\n" + text;
  }
  return id;
}
// printed card fronts number their fields (1 = family name, 2 = given names) or label them LN/FN
function guessName(text) {
  const line = (re) => { const m = text.match(re); return m ? m[1].replace(/[^A-Za-z' -]/g, " ").replace(/\s+/g, " ").trim() : ""; };
  let last = line(/^[ \t]*(?:1|LN|LAST(?: NAME)?)[ \t.:]+([A-Za-z][A-Za-z' -]{1,30})$/im);
  let given = line(/^[ \t]*(?:2|FN|FIRST(?: NAME)?)[ \t.:]+([A-Za-z][A-Za-z' -]{1,40})$/im);
  if (!last) { const m = text.match(/^[ \t]*([A-Z][A-Z'-]{1,25}),[ \t]*([A-Z][A-Z' -]{1,40})$/m); if (m) { last = m[1]; given = m[2]; } }
  if (!last || !given || last.length < 2) return null;
  const g = given.split(" ");
  return { last, first: g[0], middle: g.slice(1).join(" ") };
}
const looksLikeId = (text) =>
  (text.match(/DRIVER|LICEN[CS]E|IDENTIFICATION|IDENTITY|\bDOB\b|BIRTH|REAL ?ID|\bDL\b|\bEXP|\bISS|\bSEX\b|\bHGT\b|CLASS/gi) || []).length >= 2;
// text reads are noisy: only accept one that clearly points at a passenger
const ocrAcceptable = (res) => res.p && res.n.lastHit && (res.n.firstOk || res.n.firstPrefix || res.dobOk);
const srcName = (id) => (id.key && id.key.startsWith("mrz:") ? "passport" : id.ocr ? "card text" : id.tokens ? "badge" : "ID");

// ---------- matching ----------
function nameScore(p, id) {
  const pf = toks(p.first), pl = toks(p.last), pm = toks(p.middle);
  let idFirst, idLast, idAll;
  if (id.tokens) { idAll = new Set(id.tokens); idFirst = idAll; idLast = idAll; }
  else {
    idFirst = new Set([...toks(id.first), ...toks(id.middle)]);
    idLast = new Set(toks(id.last));
    idAll = new Set([...idFirst, ...idLast]);
  }
  const lastHit = pl.length && pl.every((t) => idLast.has(t) || [...idLast].some((x) => x.replace(/ /g, "") === t));
  const lastPartial = !lastHit && pl.some((t) => idAll.has(t));
  const firstExact = pf.length && pf.every((t) => idFirst.has(t));
  const firstPrefix = !firstExact && pf.some((t) => [...idFirst].some((x) => t.length >= 3 && x.length >= 3 && (x.startsWith(t) || t.startsWith(x))));
  // hyphenated/compound first names: "Pierre-etienne" vs ID "PIERRE ETIENNE"
  const firstJoined = !firstExact && [...idFirst].join("") === pf.join("");
  let s = 0;
  if (lastHit) s += 50; else if (lastPartial) s += 20;
  if (firstExact || firstJoined) s += 40; else if (firstPrefix) s += 20;
  if (pm.length && pm.every((t) => idAll.has(t))) s += 5;
  return { s, lastHit, firstOk: firstExact || firstJoined, firstPrefix, lastPartial };
}

function match(id) {
  const leg = trip.legs[legIdx];
  let best = null;
  for (const p of leg.pax) {
    const n = nameScore(p, id);
    const dobs = id.dob ? [id.dob] : id.dates || [];
    const dobOk = dobs.some((d) => sameDate(d, p.dob));
    const gOk = !id.gender || !p.gender || id.gender === p.gender;
    const score = n.s + (dobOk ? 40 : 0) + (id.gender && gOk ? 5 : 0);
    if (!best || score > best.score) best = { p, n, dobOk, gOk, score };
  }
  if (!best || best.score < 40) return { level: "red", title: "NOT ON MANIFEST", reasons: ["No passenger on this leg matches this ID."] };
  const r = [], warn = [];
  const { n, dobOk, gOk, p } = best;
  r.push(n.lastHit ? "✓ Last name" : n.lastPartial ? "~ Last name partial" : "✗ Last name");
  r.push(n.firstOk ? "✓ First name" : n.firstPrefix ? "~ First name similar (nickname/short?)" : "✗ First name");
  const hasDob = !!(id.dob || (id.dates && id.dates.length));
  r.push(dobOk ? "✓ DOB" : hasDob ? `✗ DOB (ID ${fmtDate(id.dob || id.dates[0])} vs manifest ${fmtDate(p.dob)})` : id.ocr ? "— DOB not read from card" : "— DOB not in barcode");
  if (id.gender) r.push(gOk ? "✓ Gender" : `✗ Gender (ID ${id.gender} vs manifest ${p.gender})`);
  if (id.expired) warn.push(`ID EXPIRED ${fmtDate(id.exp)}`);
  if (id.realId === "No") warn.push("Not REAL ID compliant");
  let level;
  if (n.lastHit && n.firstOk && dobOk && gOk && !warn.length) level = "green";
  else if (hasDob && !dobOk && n.lastHit) level = "red";
  else if (!gOk) level = "red";
  else level = "yellow";
  const title = level === "green" ? "MATCH" : level === "yellow" ? "CHECK BY EYE" : "MISMATCH";
  return { level, title, p, reasons: r, warn, n, dobOk };
}

// ---------- UI ----------
function render() {
  const app = $("#trip");
  if (!trip) { app.hidden = true; $("#load").hidden = false; return; }
  $("#load").hidden = true; app.hidden = false;
  const leg = trip.legs[legIdx];
  const boarded = leg.pax.filter((p) => p.status === "boarded").length;
  $("#tripTitle").textContent = `${trip.id || "Trip"} · Leg ${leg.n} ${leg.route}`;
  $("#count").textContent = `${boarded} / ${leg.expected}`;
  $("#count").className = boarded === leg.expected ? "count done" : "count";
  const sel = $("#leg");
  sel.hidden = trip.legs.length < 2;
  sel.innerHTML = trip.legs.map((l, i) => `<option value="${i}" ${i === legIdx ? "selected" : ""}>Leg ${l.n} ${l.route}</option>`).join("");
  const q = norm($("#search").value);
  const scans = leg.scans || [];
  const hit = (txt) => !q || norm(txt).includes(q);
  const notOn = scans.filter((sc) => !sc.res.p);
  const mism = scans.filter((sc) => sc.res.p && sc.res.level !== "green" && !sc.resolved);
  const mismPax = new Set(mism.map((sc) => sc.res.p));
  const notHere = leg.pax.filter((p) => p.status !== "boarded" && !mismPax.has(p));
  const board = leg.pax.filter((p) => p.status === "boarded");
  $("#cBoard").textContent = `${board.length}/${leg.expected}`;
  $("#cNotHere").textContent = notHere.length;
  $("#cMism").textContent = mism.length;
  $("#cNotOn").textContent = notOn.length;
  const scanLi = (sc, lvl, sub) => {
    const li = document.createElement("li"); li.className = lvl;
    const who = sc.res.p ? sc.res.p.name : idLabel(sc.id);
    const idn = sc.id.tokens ? srcName(sc.id) : `ID: ${idLabel(sc.id)} · ${fmtDate(sc.id.dob)}${sc.id.gender ? " · " + sc.id.gender : ""}`;
    li.innerHTML = `<div class="nm"><b>${esc(who)}</b></div><div class="meta">${esc(sub)}<br>${esc(idn)}</div><div class="st">${lvl === "red" ? "✗" : "?"}</div>`;
    li.onclick = () => detailSheet(sc); return li;
  };
  const paxLi = (p, lvl) => {
    const li = document.createElement("li"); li.className = lvl;
    li.innerHTML = `<div class="nm"><b>${esc(p.last)}</b>, ${esc([p.first, p.middle].filter(Boolean).join(" "))}${p.primary ? ' <span class="tag">Primary</span>' : ""}</div>
      <div class="meta">${p.gender || "?"} · ${fmtDate(p.dob)}${p.how ? ` · ${esc(p.how)}` : ""}</div>
      <div class="st">${lvl === "green" ? "✓" : p.status === "flagged" ? "!" : ""}</div>`;
    li.onclick = () => manualSheet(p); return li;
  };
  const fill = (id, arr, fn) => { const ul = $(id); ul.innerHTML = ""; arr.forEach((x) => ul.appendChild(fn(x))); ul.parentElement.hidden = !arr.length; };
  fill("#lNotOn", notOn.filter((sc) => hit(idLabel(sc.id))), (sc) => scanLi(sc, "red", "NOT ON TRIP SHEET"));
  fill("#lMism", mism.filter((sc) => hit(sc.res.p.name)), (sc) => scanLi(sc, sc.res.level === "red" ? "red" : "yellow",
    sc.res.reasons.filter((r) => !r.startsWith("✓")).concat(sc.res.warn || []).join(" · ") || "Check by eye"));
  fill("#lNotHere", notHere.filter((p) => hit(p.name)), (p) => paxLi(p, p.status === "flagged" ? "flagged" : "pending"));
  fill("#lBoard", board.filter((p) => hit(p.name)), (p) => paxLi(p, "green"));
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- scan log (continuous mode) ----------
const LEVEL_ORDER = { red: 0, yellow: 1, green: 2 };
function idKey(id) {
  if (id.key) return id.key;
  return id.tokens ? "raw:" + id.raw : `${norm(id.last)}|${norm(id.first)}|${fmtDate(id.dob)}`;
}
function idLabel(id) {
  if (id.tokens && !id.last) return id.raw.length > 40 ? id.raw.slice(0, 40) + "…" : id.raw;
  return [id.first, id.middle, id.last].filter(Boolean).join(" ");
}
let actx = null;
function beep(level) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = level === "green" ? [[880, 0.09]] : level === "yellow" ? [[660, 0.12], [660, 0.12]] : [[220, 0.35]];
    let t = actx.currentTime;
    for (const [f, d] of tones) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.type = level === "red" ? "square" : "sine";
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d); t += d + 0.06;
    }
  } catch {}
  if (navigator.vibrate) navigator.vibrate(level === "green" ? 80 : [80, 60, 80]);
}
function flash(level, text) {
  const f = $("#flash");
  f.className = `flash ${level}`; f.textContent = text; f.hidden = false;
  clearTimeout(flash._t); flash._t = setTimeout(() => (f.hidden = true), 2500);
}

function logScan(res, id) {
  const leg = trip.legs[legIdx];
  leg.scans = leg.scans || [];
  const key = idKey(id);
  const prev = leg.scans.find((x) => x.key === key);
  if (id.ocr && (prev || (res.p && res.p.status === "boarded"))) return; // same card still in view
  if (prev) { flash(prev.res.level, `Already scanned: ${prev.res.p ? prev.res.p.name : idLabel(id)}`); return; }
  // a second ID for someone already boarded (e.g. badge after license) — note it, don't double-count
  if (res.p && res.p.status === "boarded" && res.level === "green") {
    res.p.how += " + " + srcName(id);
    flash("green", `${res.p.name} — also matched ${srcName(id)}`);
    render(); return;
  }
  const entry = { key, id, res, t: new Date() };
  leg.scans.unshift(entry);
  if (res.p && res.level === "green") { res.p.status = "boarded"; res.p.how = srcName(id) + " scan"; }
  beep(res.level);
  flash(res.level, `${res.title}: ${res.p ? res.p.name : idLabel(id)}`);
  render();
}

function renderScans() {
  const leg = trip.legs[legIdx];
  const scans = leg.scans || [];
  const ul = $("#scans");
  $("#scanHdr").textContent = scans.length ? `Scanned (${scans.length}) — ${scans.filter((s) => s.res.level === "red").length} not on sheet` : "Scanned — none yet";
  ul.innerHTML = "";
  scans.forEach((sc) => {
    const li = document.createElement("li");
    const lvl = sc.res.p && sc.res.p.status === "boarded" && sc.res.level !== "red" ? "green" : sc.res.level;
    li.className = lvl;
    const who = sc.res.p ? sc.res.p.name : idLabel(sc.id);
    const sub = lvl === "green" ? "On trip sheet ✓" : lvl === "yellow" ? "Close match — tap to check" : sc.res.p ? `Mismatch vs ${sc.res.p.name} — tap` : "NOT ON TRIP SHEET";
    li.innerHTML = `<div class="nm"><b>${esc(who)}</b></div><div class="meta">${esc(sub)} · ${pad(sc.t.getHours())}:${pad(sc.t.getMinutes())}</div><div class="st">${lvl === "green" ? "✓" : lvl === "yellow" ? "?" : "✗"}</div>`;
    li.onclick = () => detailSheet(sc);
    ul.appendChild(li);
  });
}

function detailSheet(sc) {
  const { res, id } = sc;
  const box = $("#result");
  box.className = `result ${res.level}`;
  const idName = id.tokens ? "" : idLabel(id);
  box.innerHTML = `
    <div class="big">${res.title}</div>
    ${res.p ? `<div class="who">${esc(res.p.name)}<br><small>Trip sheet: ${res.p.gender} · ${fmtDate(res.p.dob)}</small></div>` : ""}
    <div class="idinfo"><small>${esc(id.kind)}${idName ? `: ${esc(idName)}` : ""}${id.dob ? ` · ${fmtDate(id.dob)}` : ""}${id.gender ? ` · ${id.gender}` : ""}${id.realId ? ` · REAL ID: ${id.realId}` : ""}${id.exp ? ` · exp ${fmtDate(id.exp)}` : ""}</small></div>
    <ul>${res.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}${(res.warn || []).map((w) => `<li class="w">⚠ ${esc(w)}</li>`).join("")}</ul>
    <div class="btns">
      ${res.p && res.p.status === "boarded" && res.level !== "green" && !sc.resolved ? `<div class="w">⚠ ${esc(res.p.name)} is already boarded — this may be a different person or a duplicate.</div><button id="rOk" class="sec">Dismiss (resolved)</button>` : ""}
      ${res.p && res.p.status !== "boarded" ? `<button id="rBoard">Verified by eye — board</button>` : ""}
      ${res.p && res.p.status === "boarded" ? `<button id="rUndo" class="sec">Un-board</button>` : ""}
      ${id.raw ? `<button id="rRaw" class="sec">${id.ocr ? "Show text read" : "Show barcode text"}</button>` : ""}
      <button id="rDel" class="sec">Remove scan</button>
      <button id="rNext">Close</button>
    </div>
    <pre id="rawTxt" hidden></pre>`;
  box.hidden = false;
  const leg = trip.legs[legIdx];
  const b = $("#rBoard"); if (b) b.onclick = () => { res.p.status = "boarded"; res.p.how = "scan + visual"; sc.resolved = true; box.hidden = true; render(); };
  const u = $("#rUndo"); if (u) u.onclick = () => { res.p.status = "pending"; res.p.how = ""; sc.resolved = false; box.hidden = true; render(); };
  const ok = $("#rOk"); if (ok) ok.onclick = () => { sc.resolved = true; box.hidden = true; render(); };
  const rr = $("#rRaw"); if (rr) rr.onclick = () => { const t = $("#rawTxt"); t.textContent = id.raw; t.hidden = !t.hidden; };
  $("#rDel").onclick = () => { leg.scans = leg.scans.filter((x) => x !== sc); box.hidden = true; render(); };
  $("#rNext").onclick = () => { box.hidden = true; };
}

function handleScan(text, img, fromPhoto) {
  if (!trip) return;
  const now = Date.now();
  if (text === lastScanText && now - lastScanAt < 3000) return;
  const id = parseAAMVA(text) || parseGeneric(text);
  const res = match(id);
  if (id.tokens && !res.p && img && !id.retried) {
    // e.g. employee badge whose barcode is just a number: read the printed name too
    if (ocrBusy && !fromPhoto) return; // try again on the next frame
    lastScanText = text; lastScanAt = now;
    return runOCR(img, id, fromPhoto);
  }
  lastScanText = text; lastScanAt = now;
  logScan(res, id);
}

// ---------- text reading (passport MRZ, ID fronts, badges) ----------
let ocrBusy = false, lastOcrAt = 0, ocrQuietUntil = 0, ocrHint = "", lastStranger = "";
function ocrState(msg) { const e = $("#ocrState"); if (e) { e.textContent = msg; e.hidden = !msg; } }
// grayscale + contrast stretch: helps with glare, colored card backgrounds and dim light
function enhance(img) {
  const d = img.data, n = d.length / 4, hist = new Uint32Array(256), Y = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const y = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; Y[i] = y; hist[y]++; }
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.02) lo++;
  acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.02) hi--;
  const k = 255 / Math.max(16, hi - lo);
  for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, (Y[i] - lo) * k)); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
  return img;
}
async function runOCR(img, barcodeId, fromPhoto) {
  ocrBusy = true; lastOcrAt = Date.now();
  ocrState(ocrHint || "Reading text…");
  try {
    const text = await ocrImage(enhance(img));
    if (!trip) return false;
    const id = ocrToId(text, barcodeId);
    const res = match(id);
    if (id.key || ocrAcceptable(res)) {
      if (!id.key) id.key = barcodeId ? "raw:" + barcodeId.raw : "ocr:" + res.p.name;
      ocrQuietUntil = Date.now() + 3000; ocrHint = ""; lastStranger = "";
      logScan(res, id);
      return true;
    }
    if (barcodeId) { barcodeId.retried = true; logScan(match(barcodeId), barcodeId); return true; }
    // not accepted: tell the operator what was seen, and catch IDs of people not on the sheet
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const guess = !id.key && looksLikeId(text) ? guessName(text) : null;
    if (res.p) ocrHint = `Close to ${res.p.name} — hold steady, closer`;
    else if (/<<</.test(text)) ocrHint = "Passport code seen — hold steady, no glare";
    else if (guess && id.dates.length) {
      const k = norm(guess.last + "|" + guess.first);
      if (k === lastStranger || fromPhoto) {
        // same name read twice and nobody on the sheet comes close
        Object.assign(id, guess, { kind: "ID front (text read)", key: "ocrnm:" + k });
        ocrQuietUntil = Date.now() + 3000; ocrHint = ""; lastStranger = "";
        logScan(res, id);
        return true;
      }
      lastStranger = k;
      ocrHint = `Saw ${guess.first} ${guess.last} — checking…`;
    } else if (letters < 12) ocrHint = "No text seen — hold card closer, flat, no glare";
    else ocrHint = "No trip-sheet name read — move closer";
    if (!fromPhoto) ocrState(ocrHint);
    return false;
  } catch (e) {
    console.warn(e);
    if (fromPhoto) toast(`Text reading failed: ${e.message || e}`);
    if (barcodeId) { barcodeId.retried = true; logScan(match(barcodeId), barcodeId); return true; }
    return false;
  } finally {
    ocrBusy = false; lastOcrAt = Date.now();
    if (!ocrHint || !stream) ocrState("");
  }
}
const ocrCanvas = document.createElement("canvas");
// the part of the video the user actually sees (object-fit: cover), scaled to ≤ maxW wide
function visibleFrame(v, maxW = 1600) {
  const r = v.getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(r.width / vw, r.height / vh) || 1;
  const sw = Math.min(vw, r.width / s), sh = Math.min(vh, r.height / s);
  const k = Math.min(1, maxW / sw);
  ocrCanvas.width = Math.round(sw * k); ocrCanvas.height = Math.round(sh * k);
  const ctx = ocrCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, ocrCanvas.width, ocrCanvas.height);
  return ctx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
}
async function fileToImageData(file, maxW = 2000) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxW / Math.max(bmp.width, bmp.height));
  ocrCanvas.width = Math.round(bmp.width * k); ocrCanvas.height = Math.round(bmp.height * k);
  const ctx = ocrCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, ocrCanvas.width, ocrCanvas.height);
  bmp.close && bmp.close();
  return ctx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
}

function manualSheet(p) {
  const box = $("#result");
  box.className = "result manual";
  box.innerHTML = `<div class="big">${esc(p.name)}</div>
    <div class="who"><small>${p.gender} · DOB ${fmtDate(p.dob)}</small></div>
    <p>Use for passports or IDs that won't scan. Check name, DOB and photo by eye.</p>
    <div class="btns">
      ${p.status !== "boarded" ? `<button id="mB">Verified — board</button>` : `<button id="mU" class="sec">Un-board</button>`}
      <button id="mF" class="sec">Flag (problem)</button>
      <button id="mC" class="sec">Close</button></div>`;
  box.hidden = false;
  const mb = $("#mB"); if (mb) mb.onclick = () => { p.status = "boarded"; p.how = "manual"; box.hidden = true; render(); };
  const mu = $("#mU"); if (mu) mu.onclick = () => { p.status = "pending"; p.how = ""; box.hidden = true; render(); };
  $("#mF").onclick = () => { p.status = "flagged"; p.how = "flagged"; box.hidden = true; render(); };
  $("#mC").onclick = () => { box.hidden = true; };
}

// ---------- camera ----------
let stream = null, scanning = false, busy = false, timer = null;
const video = () => $("#video");
async function startCam() {
  $("#camErr").hidden = true;
  try {
    const devId = $("#camSel").value;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...(devId ? { deviceId: { exact: devId } } : { facingMode: { ideal: "environment" } }), width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const v = video();
    v.srcObject = stream;
    await v.play();
    $("#cam").hidden = false;
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $("#torch").hidden = !caps.torch;
    try { if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const curId = track.getSettings().deviceId;
      const sel = $("#camSel");
      sel.innerHTML = cams.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === curId ? "selected" : ""}>${esc(c.label || "Camera " + (i + 1))}</option>`).join("");
      sel.hidden = cams.length < 2;
    } catch {}
    $("#scanBtn").textContent = "Stop camera";
    initOCR().catch((e) => ocrState(`Text reading unavailable: ${e.message}`));
    resumeScan();
  } catch (e) {
    $("#camErr").hidden = false;
    $("#camErr").textContent = `Live camera unavailable (${e.name || e}). Use "Take photo of ID" instead.`;
  }
}
function stopCam() {
  pauseScan();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; ocrHint = ""; ocrState(""); $("#cam").hidden = true; $("#scanBtn").textContent = "Start camera";
}
function pauseScan() { scanning = false; clearTimeout(timer); }
function resumeScan() { if (!stream) return; scanning = true; tick(); }
async function tick() {
  if (!scanning) return;
  const v = video();
  if (!busy && v.videoWidth) {
    busy = true;
    try {
      const c = $("#grab");
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const res = await readBarcodes(img, { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1, textMode: "Plain" });
      const now = Date.now();
      if (res.length && res[0].text) handleScan(res[0].text, visibleFrame(v));
      else if (!ocrBusy && now - lastOcrAt > 1200 && now > ocrQuietUntil) runOCR(visibleFrame(v));
    } catch (e) { console.warn(e); }
    busy = false;
  }
  timer = setTimeout(tick, 200);
}
let torchOn = false;
async function toggleTorch() {
  if (!stream) return;
  torchOn = !torchOn;
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {}
}
async function scanPhoto(file) {
  if (!file) return;
  $("#busy").hidden = false;
  try {
    const res = await readBarcodes(file, { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1, textMode: "Plain" });
    const img = await fileToImageData(file);
    if (res.length && res[0].text) { lastScanText = ""; await handleScan(res[0].text, img, true); return; }
    if (!(await runOCR(img, null, true)))
      toast(`${ocrHint || "Couldn't read a trip-sheet name from that photo"}. Fill the frame with the ID or passport photo page, good light — or check by eye and tap the passenger to board.`);
  } finally { $("#busy").hidden = true; }
}

// ---------- wiring ----------
async function loadPdf(file) {
  $("#busy").hidden = false;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const t = parseManifest(await pdfToLines(buf));
    if (!t.legs.length) throw new Error("No passengers found in that PDF.");
    trip = t; legIdx = 0; render();
  } catch (e) { toast(e.message || e); }
  finally { $("#busy").hidden = true; }
}
window.addEventListener("DOMContentLoaded", () => {
  $("#pdf").onchange = (e) => loadPdf(e.target.files[0]);
  $("#pasteGo").onclick = () => {
    const t = parsePasted($("#paste").value);
    if (!t.legs.length) return toast("No passengers found. Lines should look like: Jane Doe (Female - 3/7/81)");
    trip = t; legIdx = 0; render();
  };
  $("#search").oninput = render;
  $("#leg").onchange = (e) => { legIdx = +e.target.value; render(); };
  $("#scanBtn").onclick = () => (stream ? stopCam() : startCam());
  $("#torch").onclick = toggleTorch;
  $("#camSel").onchange = () => { if (stream) { stopCam(); startCam(); } };
  $("#photo").onchange = (e) => { scanPhoto(e.target.files[0]); e.target.value = ""; };
  $("#close").onclick = () => {
    const btn = $("#close");
    if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Tap again to erase"; setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Close trip & erase data"; }, 4000); return; }
    delete btn.dataset.armed; btn.textContent = "Close trip & erase data";
    stopCam(); trip = null; $("#result").hidden = true; $("#paste").value = ""; $("#pdf").value = ""; render();
  };
  render();
});

// test hook (no effect in normal use)
window.__idcheck = { pdfToLines, parseAAMVA, ocrToId, parseMRZ, runOCR, parseGeneric, parseManifest, match, handleScan, scanPhoto, loadPdf, get trip() { return trip; } };
