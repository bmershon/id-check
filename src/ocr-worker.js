// Runs Tesseract off the main thread so live barcode scanning stays responsive.
// Bundled to a string at build time and started from a blob: URL (no network).
import { createOCREngine, supportsFastBuild, layoutFlags } from "tesseract-wasm";

let engine = null;
// Rebuild text from word boxes, starting a new line at a wide horizontal gap: Tesseract runs side-by-side
// columns of a list together ("Jane Doe   Mei Wong"), which would read as one four-word name.
function columnText(words) {
  let out = "", prev = null;
  for (const w of words) {
    const h = w.rect.bottom - w.rect.top;
    const sameLine = prev && !(w.flags & layoutFlags.StartOfLine) && w.rect.left >= prev.rect.left;
    if (!prev) out += w.text;
    else if (!sameLine) out += "\n" + w.text;
    else out += (w.rect.left - prev.rect.right > Math.max(2.2 * h, 40) ? "\n" : " ") + w.text;
    prev = w;
  }
  return out;
}
const ALL_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "init") {
      if (!supportsFastBuild()) throw new Error("Text reading needs iOS/iPadOS 16.4 or newer.");
      engine = await createOCREngine({ wasmBinary: e.data.wasm });
      engine.loadModel(e.data.model);
      self.postMessage({ id, ok: true });
    } else if (type === "ocr") {
      // an empty whitelist blocks everything in this build, so "no restriction" = all printable ASCII
      engine.setVariable("tessedit_char_whitelist", e.data.whitelist || ALL_CHARS);
      engine.setVariable("tessedit_pageseg_mode", String(e.data.psm || 3)); // 3 = automatic layout
      engine.loadImage(e.data.image);
      const text = e.data.columns ? columnText(engine.getTextBoxes("word")) : engine.getText();
      engine.clearImage();
      self.postMessage({ id, ok: true, text });
    } else if (type === "lines") {
      engine.setVariable("tessedit_char_whitelist", e.data.whitelist || ALL_CHARS);
      engine.loadImage(e.data.image);
      const text = engine.getTextBoxes("line").map((b) => ({ text: b.text.trim(), rect: b.rect }));
      engine.clearImage();
      self.postMessage({ id, ok: true, text });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
