// Pocket Vault — sharing.
//
// Two ways to send a document to someone:
//   1. Normal copy: page images, optionally watermarked, as one PDF or as
//      JPEG images, plus the chosen details as plain text.
//   2. Secure package: the same content encrypted (AES-256-GCM) under a
//      one-time share code. The recipient opens it in Pocket Vault with the
//      code, which is sent by a different route (phone call, SMS).
//
// The vault itself is never changed by sharing.

import { b64, unb64 } from './vault.js';

export const SHARE_FORMAT = 'pocket-vault-share';
export const SHARE_FORMAT_VERSION = 1;
const SHARE_ITERATIONS = 600000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
const CODE_LENGTH = 12; // 12 symbols from 30 ≈ 59 bits

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- details text ----------

const AADHAAR_RE = /^\s*(\d{4})\s?(\d{4})\s?(\d{4})\s*$/;

export function maskAadhaar(value) {
  const m = String(value).match(AADHAAR_RE);
  return m ? `XXXX XXXX ${m[3]}` : value;
}

export function looksLikeAadhaar(field) {
  return AADHAAR_RE.test(String(field.value || '')) || /aadha?ar/i.test(field.label || '');
}

// fields: [{label, value}] already filtered to those chosen.
export function detailsText(title, fields, { mask = true } = {}) {
  const lines = [title];
  for (const f of fields) {
    let v = f.value;
    if (mask && looksLikeAadhaar(f)) v = maskAadhaar(v);
    lines.push(f.label ? `${f.label}: ${v}` : v);
  }
  return lines.join('\n');
}

// ---------- watermark ----------

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read a page image.')); };
    img.src = url;
  });
}

function canvasJpeg(canvas, quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the page.'))), 'image/jpeg', quality);
  });
}

// Returns { bytes: Uint8Array (JPEG), width, height }.
export async function preparePage(jpegBytes, watermark) {
  const img = await loadImage(new Blob([jpegBytes], { type: 'image/jpeg' }));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!watermark) return { bytes: new Uint8Array(jpegBytes), width: w, height: h };

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  // Diagonal repeated text across the page.
  const size = Math.max(14, Math.round(Math.min(w, h) / 22));
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.atan2(h, w));
  ctx.font = `600 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = 'rgba(160, 20, 20, 0.22)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const diag = Math.hypot(w, h);
  const step = size * 3.2;
  for (let y = -diag / 2; y <= diag / 2; y += step) {
    ctx.fillText(watermark, 0, y, diag * 0.95);
  }
  ctx.restore();

  // A legible band along the bottom.
  const band = Math.round(size * 1.8);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.fillRect(0, h - band, w, band);
  ctx.fillStyle = '#7A1010';
  ctx.font = `600 ${Math.round(size * 0.8)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(watermark, w / 2, h - band / 2, w * 0.96);

  const blob = await canvasJpeg(canvas);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

// ---------- minimal PDF writer (JPEG pages) ----------

// pages: [{ bytes: Uint8Array (baseline JPEG, RGB), width, height }]
export function buildPdf(pages, title = 'Document') {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? te.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const startObj = (n) => { offsets[n] = length; push(`${n} 0 obj\n`); };

  const pdfString = (s) => '(' + String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?') + ')';

  // Object numbers: 1 catalog, 2 pages, 3 info, then 3 per page.
  const n = pages.length;
  const pageObj = (i) => 4 + i * 3;
  const contentObj = (i) => 5 + i * 3;
  const imageObj = (i) => 6 + i * 3;
  const total = 3 + n * 3;

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  startObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObj(2);
  push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>\nendobj\n`);

  startObj(3);
  push(`<< /Title ${pdfString(title)} /Producer (Pocket Vault) >>\nendobj\n`);

  pages.forEach((p, i) => {
    // Page size: long edge 842 pt (A4 long side), aspect preserved.
    const scale = 842 / Math.max(p.width, p.height);
    const pw = Math.round(p.width * scale * 100) / 100;
    const ph = Math.round(p.height * scale * 100) / 100;

    startObj(pageObj(i));
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`);

    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q\n`;
    startObj(contentObj(i));
    push(`<< /Length ${te.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);

    startObj(imageObj(i));
    push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
    push(p.bytes);
    push('\nendstream\nendobj\n');
  });

  const xrefAt = length;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= total; k++) xref += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}

// ---------- secure package ----------

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export function newShareCode() {
  const out = [];
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  while (out.length < CODE_LENGTH) {
    for (const byte of rand(32)) {
      if (byte < limit && out.length < CODE_LENGTH) out.push(CODE_ALPHABET[byte % n]);
    }
  }
  return out.join('');
}

export function formatShareCode(code) {
  return normaliseShareCode(code).match(/.{1,4}/g).join('-');
}

export function normaliseShareCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function shareKey(code, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(normaliseShareCode(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// content: { title, note, fields:[{label,value}], pages:[{bytes,width,height}],
//            originals:[{name,type,bytes}] }
export async function makePackage(content, code) {
  const payload = {
    title: content.title,
    note: content.note || '',
    created: new Date().toISOString(),
    fields: content.fields || [],
    pages: (content.pages || []).map((p) => ({ type: 'image/jpeg', width: p.width, height: p.height, data: b64(p.bytes) })),
    originals: (content.originals || []).map((o) => ({ name: o.name, type: o.type, data: b64(o.bytes) })),
  };
  const salt = rand(16);
  const iv = rand(12);
  const key = await shareKey(code, salt, SHARE_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(payload)));
  const file = {
    format: SHARE_FORMAT,
    formatVersion: SHARE_FORMAT_VERSION,
    hint: 'Open in Pocket Vault: https://vidyadhar-mudkavi.github.io/pocket-vault/ (Open a shared document). The code comes separately.',
    salt: b64(salt),
    iv: b64(iv),
    iterations: SHARE_ITERATIONS,
    ct: b64(ct),
  };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

export async function readPackageFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    throw new Error('This file is not a Pocket Vault shared document.');
  }
  if (!data || data.format !== SHARE_FORMAT) {
    if (data && data.format === 'pocket-vault-backup') {
      throw new Error('This is a vault backup, not a shared document. Use Restore from backup instead.');
    }
    throw new Error('This file is not a Pocket Vault shared document.');
  }
  if (data.formatVersion > SHARE_FORMAT_VERSION) {
    throw new Error('This document was shared from a newer version of Pocket Vault. Update the app first.');
  }
  return data;
}

// Returns the decrypted payload; pages carry Uint8Array bytes.
export async function openPackage(pkg, code) {
  let plain;
  try {
    const key = await shareKey(code, unb64(pkg.salt), pkg.iterations);
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(pkg.iv) }, key, unb64(pkg.ct));
  } catch (_) {
    throw new Error('That code does not open this document. Check it with the sender.');
  }
  const payload = JSON.parse(td.decode(plain));
  payload.pages = (payload.pages || []).map((p) => ({ ...p, bytes: unb64(p.data) }));
  payload.originals = (payload.originals || []).map((o) => ({ ...o, bytes: unb64(o.data) }));
  return payload;
}

// ---------- helpers ----------

export function safeFileName(s) {
  return String(s || 'document').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document';
}

export function todayLabel() {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
