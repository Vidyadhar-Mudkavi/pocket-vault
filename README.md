# Pocket Vault

A small, private, offline document vault for Mac, iPhone and iPad.
Author: Vidyadhar Mudkavi.

Passport, Aadhaar, PAN, bank details and similar are kept **encrypted on each
device**. The app works with no network once installed. Nothing is uploaded
anywhere; this repository holds only the app's code.

## How it works

| Part | Role |
|---|---|
| `index.html`, `styles.css`, `js/app.js` | Interface |
| `js/vault.js` | Encryption (AES-256-GCM, PBKDF2-SHA256 600 000 rounds) and IndexedDB storage |
| `js/search.js` | Forgiving search, built for dictated words ("show my passport", "aadhar") |
| `js/media.js` | Turns added images and PDFs into page images for fast offline viewing |
| `js/share.js` | Sharing: watermarked copies, PDF writer, encrypted share packages |
| `js/ocr.js`, `js/extract.js` | Reads documents on the device and picks out key details |
| `vendor/tesseract/` | tesseract.js 5.1.1 and English model (Apache 2.0), bundled for offline text reading |
| `sw.js` | Service worker: keeps the app's own files offline; handles updates |
| `vendor/pdfjs/` | Mozilla pdf.js 4.10.38 (Apache 2.0), bundled so PDFs work offline |

Key handling: one random data key encrypts everything. That key is stored only
in wrapped form, once under the passphrase and once under the recovery code.
Either opens the vault. Losing both means the data cannot be recovered.

Each device has its own vault. Backups are one encrypted `.json` file that opens
with the passphrase or recovery code in use when it was made.

## Try it on the Mac (test copy, dummy documents only)

```zsh
cd /Users/Prema/Langs/Claude/Projects/pocket-vault
python3 -m http.server 8765
```

Open <http://localhost:8765> in Safari. To get the app window: Safari →
File → Add to Dock. Stop the server with Ctrl-C when done; the Dock app keeps
working offline.

The test copy at `localhost` is a **separate vault** from the real one that
will live on GitHub Pages. Put real documents only into the GitHub Pages copy.

## Publish (GitHub Pages)

1. Create a public repository named `pocket-vault` and push this folder.
2. Repository → Settings → Pages → Source: *Deploy from a branch*, branch
   `main`, folder `/ (root)`.
3. The app appears at `https://<github-user>.github.io/pocket-vault/`.
   **This address is permanent.** The documents on each device are tied to it.

Install: on iPhone/iPad open the address in Safari → Share → Add to Home Screen.
On the Mac: Safari → File → Add to Dock.

## Releasing a new version

1. Change `VERSION` in `sw.js` **and** `APP_VERSION` in `js/app.js` (same value).
2. If the stored data format changes, add a numbered step in `openDB()` in
   `js/vault.js` and raise `DB_VERSION`. Steps may add, never delete, data.
3. Push. Each device shows "Version X is ready" next time it opens online.
   Tap **Back up first**, then **Update**.

Routine: Mac first, then iPad, iPhone last — never in the week before a trip.

## Never

- Never change the hosting address after real documents are in.
- Never delete the home-screen or Dock icon without a fresh backup.
- Never clear Safari website data for this site without a fresh backup.
