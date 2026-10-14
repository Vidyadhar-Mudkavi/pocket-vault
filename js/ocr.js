// Pocket Vault — reading text from images, on the device.
// Uses Tesseract (bundled, English) for pictures; PDFs that already contain
// text are read directly with pdf.js, which is faster and exact.

let workerPromise = null;

function vendorUrl(path) {
  return new URL(`../vendor/tesseract/${path}`, import.meta.url).href;
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import('../vendor/tesseract/tesseract.esm.min.js');
      const Tesseract = mod.default || mod;
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: vendorUrl('worker.min.js'),
        corePath: vendorUrl('tesseract-core-simd-lstm.wasm.js'),
        langPath: vendorUrl('lang'),
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
        logger: (m) => {
          if (workerPromise && workerPromise.onProgress) workerPromise.onProgress(m);
        },
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  workerPromise.onProgress = onProgress;
  return workerPromise;
}

// image: a canvas, ImageBitmap, Blob or File that the browser can decode.
export async function recognise(image, onProgress) {
  const worker = await getWorker((m) => {
    if (onProgress && m && m.status === 'recognizing text') onProgress(m.progress || 0);
  });
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  return confidentText(data);
}

// Indian documents mix English with Kannada, Hindi and other scripts. The
// English reader turns those into confident-looking gibberish ("Rogarn dog
// swdsd") but marks it with near-zero confidence. Keep only words it is
// reasonably sure of, and drop stray marks at the start of a line.
const MIN_WORD = 30;
function confidentText(data) {
  if (!data) return '';
  if (!Array.isArray(data.blocks) || !data.blocks.length) return data.text || '';
  const out = [];
  for (const block of data.blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || []).filter((w) => w.confidence >= MIN_WORD && w.text.trim());
        while (words.length && !/[A-Za-z0-9#]/.test(words[0].text)) words.shift();
        while (words.length && !/[A-Za-z0-9.)]/.test(words[words.length - 1].text)) words.pop();
        if (words.length) out.push(words.map((w) => w.text).join(' '));
      }
    }
  }
  return out.join('\n');
}

// Release the memory used by the text reader (about 20–40 MB).
export async function release() {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch (_) { /* ignore */ }
  workerPromise = null;
}
