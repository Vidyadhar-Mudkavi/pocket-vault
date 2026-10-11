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

// askPassword(reasonText) -> Promise<string|null>; null cancels.
// onProgress(done, total)
// -> { pages: [{bytes,type,width,height}], totalPages, truncated }
export async function pdfToPages(file, { askPassword, onProgress } = {}) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({ data, isEvalSupported: false });
  let cancelled = false;
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
    updatePassword(pw);
  };
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (cancelled) throw new Error(`Skipped “${file.name}” (no password given).`);
    throw new Error(`Could not read “${file.name}” as a PDF.`);
  }
  const total = doc.numPages;
  const count = Math.min(total, MAX_PDF_PAGES);
  const pages = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_EDGE / Math.max(v1.width, v1.height));
    const viewport = page.getViewport({ scale });
    const canvas = makeCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await canvasToBlob(canvas);
    pages.push({ bytes: await blob.arrayBuffer(), type: 'image/jpeg', width: canvas.width, height: canvas.height });
    page.cleanup();
    if (onProgress) onProgress(i, count);
  }
  await doc.destroy();
  return { pages, totalPages: total, truncated: total > count };
}
