// Runs Tesseract off the main thread so live barcode scanning stays responsive.
// Bundled to a string at build time and started from a blob: URL (no network).
import { createOCREngine, supportsFastBuild } from "tesseract-wasm";

let engine = null;
self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "init") {
      if (!supportsFastBuild()) throw new Error("Text reading needs iOS/iPadOS 16.4 or newer.");
      engine = await createOCREngine({ wasmBinary: e.data.wasm });
      engine.loadModel(e.data.model);
      self.postMessage({ id, ok: true });
    } else if (type === "ocr") {
      engine.loadImage(e.data.image);
      const text = engine.getText();
      engine.clearImage();
      self.postMessage({ id, ok: true, text });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
