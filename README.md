# Door ID Check

Single-page web app for checking passenger IDs at the airstair against a JetInsight crew itinerary.

- Load the itinerary PDF (or paste the passenger list).
- Scan the PDF417 barcode on the back of a US driver's license / state ID, or a badge barcode/QR.
- Passengers sort into **Boarded**, **Not here yet**, **Mismatch** (name matches but DOB/gender differs, expired, not REAL ID) and **Not on trip sheet**.

Everything runs on the device, in memory. No data is saved or sent; a Content-Security-Policy blocks all network access. Scanning does not replace comparing the ID photo to the person.

## Hosting

`index.html` is fully self-contained (~3 MB). Live camera access needs HTTPS — enable GitHub Pages (Settings → Pages → Deploy from branch → `main` / root) and open `https://bmershon.github.io/id-check/` on the iPad.

## Building

```sh
npm install
npm run build   # writes index.html from src/
```

`test/` holds synthetic (fake) license and badge barcodes for testing.
