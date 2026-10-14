// Pocket Vault — turns added files into page images for fast offline viewing.
// Images are downscaled; PDFs are rendered page by page with pdf.js (bundled).

const MAX_EDGE = 2400;      // px, long edge of a stored page image
const JPEG_QUALITY = 0.88;
export const MAX_PDF_PAGES = 30;

let pdfjsPromise = null;

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the page image.'))), 'image/jpeg', JPEG_QUALITY);
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch (_) {
    throw new Error(`“${file.name}” is not an image this browser can read. Try a JPEG, PNG or PDF.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function isImage(file) {
  return (file.type && file.type.startsWith('image/')) || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(file.name);
}

// -> { bytes: ArrayBuffer, type, width, height }
export async function imageToPage(file) {
  const src = await decodeImage(file);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const canvas = makeCanvas(w0 * scale, h0 * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  const blob = await canvasToBlob(canvas);
  return { bytes: await blob.arrayBuffer(), type: 'image/jpeg', width: canvas.width, height: canvas.height };
}

// Opens a PDF, asking for its password if needed.
// -> { doc, password, lib }
export async function openPdf(file, { askPassword, password } = {}) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({ data, isEvalSupported: false, password: password || undefined });
  let cancelled = false;
  let used = password || null;
  task.onPassword = async (updatePassword, reason) => {
    const wrong = reason === lib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = askPassword
      ? await askPassword(wrong ? `Wrong password for “${file.name}”. Try again.` : `“${file.name}” is password-protected. Enter its password.`)
      : null;
    if (pw == null) {
      cancelled = true;
      task.destroy();
      return;
    }
    used = pw;
    updatePassword(pw);
  };
  try {
    const doc = await task.promise;
    return { doc, password: used, lib };
  } catch (_) {
    if (cancelled) throw new Error(`Skipped “${file.name}” (no password given).`);
    throw new Error(`Could not read “${file.name}” as a PDF.`);
  }
}

async function renderPdfPage(doc, i) {
  const page = await doc.getPage(i);
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(3, MAX_EDGE / Math.max(v1.width, v1.height));
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

// askPassword(reasonText) -> Promise<string|null>; null cancels.
// onProgress(done, total)
// -> { pages: [{bytes,type,width,height}], totalPages, truncated, password }
export async function pdfToPages(file, { askPassword, onProgress, password } = {}) {
  const { doc, password: used } = await openPdf(file, { askPassword, password });
  const total = doc.numPages;
  const count = Math.min(total, MAX_PDF_PAGES);
  const pages = [];
  for (let i = 1; i <= count; i++) {
    const canvas = await renderPdfPage(doc, i);
    const blob = await canvasToBlob(canvas);
    pages.push({ bytes: await blob.arrayBuffer(), type: 'image/jpeg', width: canvas.width, height: canvas.height });
    if (onProgress) onProgress(i, count);
  }
  await doc.destroy();
  return { pages, totalPages: total, truncated: total > count, password: used };
}

// ---------- for reading text ----------

// Text already inside a PDF (first few pages), joined line by line.
// -> { text, password, firstPage: canvas|null } ; firstPage only when the PDF has
//    no usable text (a scan), so it can be read as a picture instead.
export async function pdfTextOrImage(file, { askPassword, password, maxPages = 3 } = {}) {
  const { doc, password: used } = await openPdf(file, { askPassword, password });
  const lines = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Some PDFs (e.g. e-Aadhaar re-saved on a Mac) place every letter as its
    // own item. Join items by position: a space only where there is a gap.
    let line = '';
    let lastY = null;
    let prevEnd = null;
    let space = false;
    const flush = () => {
      const l = line.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
      if (l) lines.push(l);
      line = ''; prevEnd = null; space = false;
    };
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const [a, b0, , , x, yRaw] = it.transform;
      if (Math.abs(b0) > Math.abs(a) * 0.1) continue; // rotated side text (e.g. download date)
      const y = Math.round(yRaw);
      if (lastY !== null && Math.abs(y - lastY) > 2) flush();
      lastY = y;
      if (!it.str.trim()) { space = true; if (it.hasEOL) flush(); continue; }
      const size = Math.hypot(a, b0) || it.height || 10;
      if (line && (space || prevEnd === null || x - prevEnd > size * 0.18 || x < prevEnd - size)) line += ' ';
      line += it.str;
      prevEnd = x + (it.width || 0);
      space = /\s$/.test(it.str);
      if (it.hasEOL) flush();
    }
    flush();
    page.cleanup();
  }
  const text = lines.filter(Boolean).join('\n');
  let firstPage = null;
  if (text.replace(/\s/g, '').length < 40) firstPage = await renderPdfPage(doc, 1);
  await doc.destroy();
  return { text, password: used, firstPage };
}

// A canvas suitable for text recognition (handles HEIC via Safari's decoder).
export async function imageForOcr(file) {
  const src = await decodeImage(file);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const long = Math.max(w0, h0);
  const scale = long < 1400 ? 1400 / long : Math.min(1, 2600 / long);
  const canvas = makeCanvas(w0 * scale, h0 * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  return canvas;
}
