// Text reading for documents without a usable barcode:
//  - passports / passport cards: the machine-readable zone (MRZ), validated by check digits
//  - driver license / REAL ID fronts, employee badges: printed name, dates, sex
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
export async function ocrImage(img) {
  await initOCR();
  const data = new Uint8ClampedArray(img.data); // copy so the caller's buffer stays usable
  return call({ type: "ocr", image: { width: img.width, height: img.height, data } }, [data.buffer]);
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
    .filter((l) => l.length >= 26 && (l.match(/</g) || []).length >= 2);
}
function mrzName(s) {
  // "ERIKSSON<<ANNA<MARIA<<<<<" — filler '<' is sometimes read as K, so trim long K/< tails
  s = letters(s).replace(/[<K]{3,}$/, "").replace(/<+$/, "");
  const [last, rest = ""] = s.split(/<<+/);
  const given = rest.split("<").filter(Boolean);
  return { last: last.replace(/</g, " ").trim(), first: given[0] || "", middle: given.slice(1).join(" ") };
}
const mrzDate = (s, future) => {
  const y = +s.slice(0, 2), cur = new Date().getFullYear() % 100;
  return { y: future ? 2000 + y : y > cur ? 1900 + y : 2000 + y, m: +s.slice(2, 4), d: +s.slice(4, 6) };
};
const mrzSex = (c) => (c === "M" ? "M" : c === "F" ? "F" : "X");
function result(kind, doc, dobS, sexC, expS, name, country, raw) {
  const exp = mrzDate(expS, true);
  const dob = mrzDate(dobS, false);
  if (dob.m < 1 || dob.m > 12 || dob.d < 1 || dob.d > 31) return null;
  return {
    kind, ...name, dob, gender: mrzSex(sexC), exp,
    expired: new Date(exp.y, exp.m - 1, exp.d, 23, 59) < new Date(),
    state: country, idLast4: doc.replace(/</g, "").slice(-4),
    key: `mrz:${doc}|${dobS}`, raw,
  };
}
export function parseMRZ(text) {
  const L = mrzLines(text);
  for (let i = 0; i + 1 < L.length; i++) {
    // TD3: passport book data page
    if (L[i][0] === "P" && L[i].length >= 38 && L[i + 1].length >= 38) {
      const a = fit(L[i], 44), b = fit(L[i + 1], 44);
      const doc = b.slice(0, 9), dob = digits(b.slice(13, 19)), exp = digits(b.slice(21, 27));
      if (ok(dob, digits(b[19])) && ok(exp, digits(b[27])) && ok(doc, digits(b[9])))
        return result("Passport (MRZ)", doc, dob, b[20], exp, mrzName(a.slice(5)), letters(a.slice(2, 5)).replace(/</g, ""), `${a}\n${b}`);
    }
    // TD1: US passport card, many ID cards (3 lines of 30)
    if (i + 2 < L.length && /^[ACI]/.test(L[i]) && L[i].length >= 26 && L[i + 1].length >= 26) {
      const a = fit(L[i], 30), b = fit(L[i + 1], 30), c = fit(L[i + 2], 30);
      const doc = a.slice(5, 14), dob = digits(b.slice(0, 6)), exp = digits(b.slice(8, 14));
      if (ok(dob, digits(b[6])) && ok(exp, digits(b[14])) && ok(doc, digits(a[14])))
        return result(a[1] === "P" ? "Passport card (MRZ)" : "ID card (MRZ)", doc, dob, b[7], exp, mrzName(c), letters(a.slice(2, 5)).replace(/</g, ""), `${a}\n${b}\n${c}`);
    }
  }
  return null;
}

// ---------- printed card front (license / REAL ID / badge) ----------
export function ocrFields(text) {
  // OCR often reads 0 as O inside numbers: "O3/07/1981"
  const fixed = text.replace(/(\d)[Oo]/g, "$10").replace(/[Oo](\d)/g, "0$1");
  const sex = fixed.match(/\bSEX\s*[:.]?\s*([MFX])\b/i);
  return { fixed, gender: sex ? sex[1].toUpperCase() : "" };
}
