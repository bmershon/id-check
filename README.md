# Door ID Check

Single-page web app for checking passenger IDs at the airstair against a JetInsight crew itinerary.

- Load the itinerary PDF (or paste the passenger list).
- Scan with the live camera (or a photo):
  - the PDF417 barcode on the back of a US driver's license / state ID,
  - the front of a license / REAL ID or an employee badge (e.g. Walmart) — printed text is read on-device (Tesseract OCR) and accepted only when it matches a passenger on the leg,
  - a passport or passport card — the machine-readable `<<<` lines are read and validated by their check digits,
  - a badge barcode/QR (if it holds no name, the printed name on the badge is read too).
- Passengers sort into **Boarded**, **Not here yet**, **Mismatch** (name matches but DOB/gender differs, expired, not REAL ID) and **Not on trip sheet**.

Everything runs on the device, in memory. No data is saved or sent; a Content-Security-Policy blocks all network access. Scanning does not replace comparing the ID photo to the person.

## Hosting

`index.html` is fully self-contained (~11 MB, including the OCR engine and English model). Live camera access needs HTTPS — enable GitHub Pages (Settings → Pages → Deploy from branch → `main` / root) and open `https://bmershon.github.io/id-check/` on the iPad.

## Building

```sh
npm install
npm run build   # downloads the OCR model once into build/, writes index.html from src/
```

`test/` holds synthetic (fake) license and badge barcodes for testing.

Text reading needs iOS/iPadOS 16.4+ (WebAssembly SIMD). A stranger's ID *front* can't be flagged "not on trip sheet" (random text isn't evidence of an ID) — scan the back barcode or passport for that.
