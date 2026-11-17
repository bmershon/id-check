# Door ID Check

## ▶ Open the app: **[bmershon.github.io/id-check](https://bmershon.github.io/id-check/)**

Single-page web app for checking passenger IDs at the airstair against a JetInsight crew itinerary.

- Load the itinerary PDF, paste the passenger list, or photograph the printed trip sheet. Photos and scanned PDFs (no text layer) are read on-device with OCR; the passenger lines land in the paste box to proof-read before use.
- Scan each passenger with the live camera (or a photo):
  - the PDF417 barcode on the back of a US driver's license / REAL ID,
  - the machine-readable zone (the `<<<` lines) on a passport photo page or US passport card. Birth and expiry dates are validated by their check digits; names are matched tolerantly against the trip sheet.
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

OCR (passports, trip-sheet photos) needs iOS/iPadOS 16.4+ (WebAssembly SIMD).
