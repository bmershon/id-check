// On-device text reading (Tesseract):
//  - passports / passport cards: the machine-readable zone (MRZ), validated by check digits
//  - trip sheets: photos or scanned PDFs without a text layer
import WORKER_SRC from "../build/ocr-worker.js.txt";
import WASM_B64 from "../build/tesseract-core.wasm.b64";
import MODEL_B64 from "../build/eng.traineddata.b64";

// ---------- worker client ----------
let worker = null, ready = null, seq = 0;
const waiting = new Map();
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}
export function initOCR() {
  if (ready) return ready;
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    e.data.ok ? w.resolve(e.data.text) : w.reject(new Error(e.data.error));
  };
  const wasm = b64ToBytes(WASM_B64), model = b64ToBytes(MODEL_B64);
  ready = call({ type: "init", wasm: wasm.buffer, model: model.buffer }, [wasm.buffer, model.buffer]);
  ready.catch(() => {});
  return ready;
}
export const MRZ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
export async function ocrLines(img, { whitelist = "" } = {}) {
  await initOCR();
  const data = new Uint8ClampedArray(img.data);
  return call({ type: "lines", whitelist, image: { width: img.width, height: img.height, data } }, [data.buffer]);
}
export async function ocrImage(img, { whitelist = "" } = {}) {
  await initOCR();
  const data = new Uint8ClampedArray(img.data); // copy so the caller's buffer stays usable
  return call({ type: "ocr", whitelist, image: { width: img.width, height: img.height, data } }, [data.buffer]);
}

// ---------- MRZ (passport TD3 2x44, passport card / ID card TD1 3x30) ----------
const val = (c) => (c >= "0" && c <= "9" ? +c : c >= "A" && c <= "Z" ? c.charCodeAt(0) - 55 : 0);
const checkDigit = (s) => [...s].reduce((t, c, i) => t + val(c) * [7, 3, 1][i % 3], 0) % 10;
const digits = (s) => s.replace(/[OQDU]/g, "0").replace(/[IL|]/g, "1").replace(/Z/g, "2").replace(/S/g, "5").replace(/B/g, "8").replace(/G/g, "6").replace(/T/g, "7");
const letters = (s) => s.replace(/0/g, "O").replace(/1/g, "I").replace(/5/g, "S").replace(/8/g, "B").replace(/2/g, "Z").replace(/6/g, "G");
const ok = (field, cd) => /^\d$/.test(cd) && checkDigit(field) === +cd;
const fit = (s, n) => (s + "<".repeat(n)).slice(0, n);

function mrzLines(text) {
  return text
    .toUpperCase()
    .split(/\n+/)
    .map((l) => l.replace(/«/g, "<<").replace(/[‹(\[{]/g, "<").replace(/\s+/g, "").replace(/[^A-Z0-9<]/g, ""))
    .filter((l) => l.length >= 20);
}
// "ERIKSSON<<ANNA<MARIA<<<<<" — filler '<' is often read as C or K, so trim long tails of them
const trimFill = (s) => letters(s).replace(/[<CK]{3,}$/, "").replace(/<+$/, "");
function mrzName(s) {
  const [last, rest = ""] = trimFill(s).split(/<<+/);
  const given = rest.split("<").filter(Boolean);
  return { last: last.replace(/</g, " ").trim(), first: given[0] || "", middle: given.slice(1).join(" ") };
}
const mrzDate = (s, future) => {
  const y = +s.slice(0, 2), cur = new Date().getFullYear() % 100;
  return { y: future ? 2000 + y : y > cur ? 1900 + y : 2000 + y, m: +s.slice(2, 4), d: +s.slice(4, 6) };
};
const mrzSex = (c) => (c === "M" ? "M" : c === "F" ? "F" : "X");
function result(kind, doc, dobS, sexC, expS, nameField, nameMax, country, raw) {
  const exp = mrzDate(expS, true);
  const dob = mrzDate(dobS, false);
  if (dob.m < 1 || dob.m > 12 || dob.d < 1 || dob.d > 31 || exp.m < 1 || exp.m > 12) return null;
  return {
    kind, ...mrzName(nameField), dob, gender: mrzSex(sexC), exp,
    expired: new Date(exp.y, exp.m - 1, exp.d, 23, 59) < new Date(),
    state: country, idLast4: doc.replace(/</g, "").slice(-4),
    mrzName: trimFill(nameField), mrzNameMax: nameMax,
    key: `mrz:${dobS}|${expS}`, raw,
  };
}
// Finds "DOB(6) cd SEX EXP(6) cd" anywhere in a line, so a dropped or extra character earlier in the
// line (passport number area) doesn't shift it. Both date check digits must pass.
function findDates(line) {
  for (let k = 0; k + 15 <= line.length; k++) {
    const dob = digits(line.slice(k, k + 6)), exp = digits(line.slice(k + 8, k + 14));
    if (!/^\d{6}$/.test(dob) || !/^\d{6}$/.test(exp)) continue;
    if (ok(dob, digits(line[k + 6])) && ok(exp, digits(line[k + 14]))) return { k, dob, exp, sex: line[k + 7] };
  }
  return null;
}
// a name line: mostly letters, with "<" fillers (which OCR may read as C/K) or the "P<" passport prefix
const nameLike = (l) => l && (/</.test(l) || /^P/.test(l)) && (l.match(/[A-Z]/g) || []).length >= 4 && (l.match(/\d/g) || []).length <= 3;
export function parseMRZ(text) {
  const L = mrzLines(text);
  for (let j = 0; j < L.length; j++) {
    const f = findDates(L[j]);
    if (!f) continue;
    const b = L[j];
    if (!/</.test(b) && !L.slice(Math.max(0, j - 2), j + 3).some((l) => /<</.test(l))) continue;
    if (f.k >= 6) {
      // TD3 passport book: name line is the line above (expected position 13 on line 2)
      const a = [L[j - 1], L[j - 2]].find(nameLike) || "";
      const nameField = a[0] === "P" && a.length > 5 ? a.slice(5) : a.replace(/^P.?[A-Z0-9]{3}/, "");
      const r = result("Passport (MRZ)", b.slice(Math.max(0, f.k - 13), Math.max(0, f.k - 4)), f.dob, f.sex, f.exp, nameField, 39,
        letters(b.slice(f.k - 3, f.k)).replace(/</g, ""), [a, b].filter(Boolean).join("\n"));
      if (r) return r;
    } else {
      // TD1 (US passport card, ID cards): dates start line 2; names on line 3, document line above
      const a = L[j - 1] || "", c = [L[j + 1], L[j + 2]].find(nameLike) || "";
      const r = result(a[1] === "P" ? "Passport card (MRZ)" : "ID card (MRZ)", a.slice(5, 14), f.dob, f.sex, f.exp, c, 30,
        letters(b.slice(f.k + 15, f.k + 18)).replace(/</g, ""), [a, b, c].filter(Boolean).join("\n"));
      if (r) return r;
    }
  }
  return null;
}
// How closely an OCR'd MRZ name field matches a passenger, 0..1 (tolerates '<' read as C/K, dropped fillers)
export function mrzNameSimilarity(field, last, given, max) {
  const z = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]+/g, "<").replace(/^<|<$/g, "");
  const want = (z(last) + "<<" + z(given)).slice(0, max);
  const got = field.replace(/<+$/, "");
  if (!got || !want) return 0;
  const d = Array.from({ length: got.length + 1 }, (_, i) => i);
  for (let j = 1; j <= want.length; j++) {
    let prev = d[0]; d[0] = j;
    for (let i = 1; i <= got.length; i++) {
      const t = d[i];
      d[i] = Math.min(d[i] + 1, d[i - 1] + 1, prev + (got[i - 1] === want[j - 1] || (got[i - 1] === "<" && "CK".includes(want[j - 1])) || (want[j - 1] === "<" && "CK".includes(got[i - 1])) ? 0 : 1));
      prev = t;
    }
  }
  return 1 - d[got.length] / Math.max(got.length, want.length);
}
