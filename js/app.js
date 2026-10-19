// Pocket Vault — user interface.
import * as vault from './vault.js';
import { search } from './search.js';
import { imageToPage, pdfToPages, pdfTextOrImage, imageForOcr, isPdf, isImage, MAX_PDF_PAGES } from './media.js';
import * as share from './share.js';
import { extractDetails } from './extract.js';
import * as ocr from './ocr.js';

export const APP_VERSION = '1.2.5';
const AUTO_LOCK_MS = 5 * 60 * 1000;   // lock after 5 minutes without a touch or key
const HIDDEN_LOCK_MS = 60 * 1000;     // lock if the app was in the background over a minute
const DAY = 86400000;

// ---------- icons ----------
const I = {
  identity: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M6 15.5c.6-1.2 1.5-1.8 2.5-1.8s1.9.6 2.5 1.8M14 10h4M14 13h3"/></svg>',
  travel: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M9 16h6"/></svg>',
  bank: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/></svg>',
  vehicle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16l1.5-5a2 2 0 0 1 1.9-1.4h7.2a2 2 0 0 1 1.9 1.4L19 16"/><rect x="3" y="15" width="18" height="4" rx="1.5"/><circle cx="7.5" cy="17" r=".8"/><circle cx="16.5" cy="17" r=".8"/></svg>',
  medical: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  property: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5"/></svg>',
  other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
};

const CATEGORIES = [
  { id: 'identity', label: 'Identity', presets: ['Number', 'Name as printed', 'Date of birth'] },
  { id: 'travel', label: 'Travel', presets: ['Number', 'Date of expiry', 'Place of issue'] },
  { id: 'bank', label: 'Bank', presets: ['Account number', 'IFSC', 'Branch', 'Customer ID'] },
  { id: 'vehicle', label: 'Vehicle', presets: ['Registration number', 'Valid until'] },
  { id: 'medical', label: 'Medical', presets: ['Policy number', 'Insurer', 'Valid until'] },
  { id: 'property', label: 'Property', presets: ['Reference number'] },
  { id: 'other', label: 'Other', presets: [] },
];
const catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

// ---------- state ----------
const state = {
  items: [],
  query: '',
  category: 'all',
  selectedId: null,
  urls: new Map(),      // blob id -> object URL (revoked on lock)
  busy: 0,              // long operations in progress (blocks auto-lock)
  lastActivity: Date.now(),
  hiddenAt: null,
  viewerOpen: false,
  wakeLock: null,
  edit: null,
  pendingRecovery: null,
  updateWorker: null,
  updateRequested: false,
};

const $ = (id) => document.getElementById(id);
const isTouch = window.matchMedia('(pointer: coarse)').matches;
const isWide = () => window.matchMedia('(min-width: 900px)').matches;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(screenId) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== screenId;
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function errText(err) {
  if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
    return 'This device has run out of space for the vault. Free some storage and try again.';
  }
  return (err && err.message) || String(err);
}

// ---------- generic ask dialog ----------
// ask({ title, text, input:'password'|'text', okLabel, cancelLabel, noCancel, danger, code, error })
// -> string (input), true (ok), or null (cancel)
function ask(opts) {
  return new Promise((resolve) => {
    const d = $('dlg-ask');
    const input = $('ask-input');
    $('ask-title').textContent = opts.title || '';
    $('ask-text').textContent = opts.text || '';
    $('ask-error').textContent = opts.error || '';
    input.hidden = !opts.input;
    input.type = opts.input === 'text' ? 'text' : 'password';
    input.value = '';
    let codeEl = d.querySelector('.recovery-code');
    if (codeEl) codeEl.remove();
    if (opts.code) {
      codeEl = document.createElement('p');
      codeEl.className = 'recovery-code';
      codeEl.textContent = opts.code;
      $('ask-text').after(codeEl);
    }
    const ok = $('ask-ok');
    ok.textContent = opts.okLabel || 'OK';
    ok.className = 'btn ' + (opts.danger ? 'primary danger-fill' : 'primary');
    const cancel = $('ask-cancel');
    cancel.textContent = opts.cancelLabel || 'Cancel';
    cancel.hidden = !!opts.noCancel;
    const form = $('form-ask');
    const finish = (value) => {
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', onCancel);
      d.removeEventListener('cancel', onEsc);
      if (d.open) d.close();
      resolve(value);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(opts.input ? input.value : true); };
    const onCancel = () => finish(null);
    const onEsc = (e) => { e.preventDefault(); if (!opts.noCancel) finish(null); };
    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', onCancel);
    d.addEventListener('cancel', onEsc);
    d.showModal();
    if (opts.input) input.focus();
    else ok.focus();
  });
}

// ---------- dates and expiry ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function makeDate(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

export function parseDate(s) {
  s = String(s || '').trim();
  let m;
  if ((m = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/))) return makeDate(+m[3], +m[2] - 1, +m[1]); // DD/MM/YYYY
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return makeDate(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?,?[\s-]+(\d{4})$/))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return makeDate(+m[3], mi, +m[1]);
  }
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return makeDate(+m[3], mi, +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[/\-.](\d{4})$/))) {          // MM/YYYY -> last day of month
    const mo = +m[1] - 1;
    if (mo >= 0 && mo < 12) return new Date(+m[2], mo + 1, 0);
  }
  return null;
}

function daysUntilExpiry(item) {
  for (const f of item.fields || []) {
    if (/expir|valid|renew|due/i.test(f.label || '')) {
      const d = parseDate(f.value);
      if (d) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Math.round((d - today) / DAY);
      }
    }
  }
  return null;
}

function expiryText(days) {
  if (days == null) return null;
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days <= 60) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  if (days <= 270) return `Expires in ${Math.round(days / 30)} months`;
  return null;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) { return iso; }
}

// ---------- blob URLs ----------
async function blobUrl(page) {
  if (state.urls.has(page.id)) return state.urls.get(page.id);
  const bytes = await vault.getBlobBytes(page.id);
  const url = URL.createObjectURL(new Blob([bytes], { type: page.type || 'application/octet-stream' }));
  state.urls.set(page.id, url);
  return url;
}

async function hydrate(root) {
  const imgs = root.querySelectorAll('img[data-blob]');
  for (const img of imgs) {
    const id = img.dataset.blob;
    const type = img.dataset.type || 'image/jpeg';
    try {
      img.src = await blobUrl({ id, type });
    } catch (_) { /* locked meanwhile, or missing */ }
  }
}

function revokeAll() {
  for (const url of state.urls.values()) URL.revokeObjectURL(url);
  state.urls.clear();
}

// ---------- boot ----------
async function boot() {
  wire();
  registerServiceWorker();
  try {
    if (await vault.isSetUp()) showUnlock();
    else show('screen-setup');
  } catch (err) {
    show('screen-loading');
    $('screen-loading').innerHTML = `<p class="error">Could not open storage: ${esc(errText(err))}</p>`;
  }
}

function setUnlockMode(recovery) {
  $('form-unlock').hidden = recovery;
  $('form-recovery-unlock').hidden = !recovery;
  $('unlock-toggle').textContent = recovery ? 'Use the passphrase instead' : 'Forgot the passphrase? Use the recovery code';
  $('unlock-recovery').value = '';
  $('recovery-unlock-error').textContent = '';
  setTimeout(() => (recovery ? $('unlock-recovery') : $('unlock-pass')).focus(), 50);
}

function showUnlock() {
  show('screen-unlock');
  setUnlockMode(false);
  $('unlock-pass').value = '';
  $('unlock-error').textContent = '';
  if (!isTouch) setTimeout(() => $('unlock-pass').focus(), 50);
}

async function enterApp() {
  state.items = await vault.listItems();
  state.query = '';
  state.category = 'all';
  state.selectedId = null;
  $('q').value = '';
  document.body.classList.remove('detail-open');
  show('screen-app');
  state.lastActivity = Date.now();
  render();
  vault.requestPersistentStorage();
  if (state.updateWorker) showUpdateBanner();
}

function lockNow() {
  if (!vault.isUnlocked()) return;
  vault.lock();
  closeViewer();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  cleanupEdit();
  revokeAll();
  state.items = [];
  state.selectedId = null;
  $('list').innerHTML = '';
  $('detail').innerHTML = '';
  document.body.classList.remove('detail-open');
  showUnlock();
}

// ---------- rendering ----------
function render() {
  renderChips();
  renderList();
  renderDetail();
}

function renderChips() {
  const counts = {};
  for (const it of state.items) counts[it.category] = (counts[it.category] || 0) + 1;
  const chips = [{ id: 'all', label: `All ${state.items.length}` }];
  for (const c of CATEGORIES) {
    if (counts[c.id] || state.category === c.id) chips.push({ id: c.id, label: c.label });
  }
  $('chips').innerHTML = chips
    .map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${state.category === c.id}">${esc(c.label)}</button>`)
    .join('');
}

function visibleItems() {
  let items = state.items;
  if (state.category !== 'all') items = items.filter((i) => i.category === state.category);
  if (state.query.trim()) return search(items, state.query).map((r) => r.item);
  return [...items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.title.localeCompare(b.title));
}

function itemRow(item) {
  const cat = catOf(item.category);
  const nPages = (item.pages || []).length;
  const exp = expiryText(daysUntilExpiry(item));
  const sub = [cat.label, nPages ? `${nPages} page${nPages === 1 ? '' : 's'}` : 'details only'].join(' · ');
  const first = (item.pages || [])[0];
  const icon = first
    ? `<img alt="" data-blob="${esc(first.id)}" data-type="${esc(first.type)}">`
    : I[cat.id] || I.other;
  return `<button type="button" class="item" data-id="${esc(item.id)}" aria-current="${state.selectedId === item.id}">
    <span class="item-icon">${icon}</span>
    <span class="item-text"><span class="item-title">${esc(item.title)}</span>
    <span class="item-sub${exp ? ' warn' : ''}">${esc(exp ? `${sub} · ${exp}` : sub)}</span></span>
    ${I.chev}</button>`;
}

function renderList() {
  const list = $('list');
  const items = visibleItems();
  if (!state.items.length) {
    list.innerHTML = `<div class="empty"><p><strong>Nothing here yet.</strong></p>
      <p>Tap <strong>+</strong> to add your passport, Aadhaar, PAN, bank details — or ${isTouch ? 'use the camera' : 'drag files onto this window'}.</p></div>`;
    return;
  }
  if (!items.length) {
    list.innerHTML = `<div class="empty"><p>No match for “${esc(state.query)}”.</p><p class="hint">Try one word, such as passport or bank.</p></div>`;
    return;
  }
  let html = '';
  if (!state.query.trim() && state.category === 'all') {
    const pinned = items.filter((i) => i.pinned);
    const rest = items.filter((i) => !i.pinned);
    if (pinned.length) html += `<p class="section-label">Pinned</p>${pinned.map(itemRow).join('')}`;
    if (rest.length) html += `${pinned.length ? '<p class="section-label">Everything else</p>' : ''}${rest.map(itemRow).join('')}`;
  } else {
    html = items.map(itemRow).join('');
  }
  list.innerHTML = html;
  hydrate(list);
}

function selected() {
  return state.items.find((i) => i.id === state.selectedId) || null;
}

function renderDetail() {
  const el = $('detail');
  const item = selected();
  if (!item) {
    el.innerHTML = `<div class="detail-empty"><p>${state.items.length ? 'Select a document to see it here.' : 'Your documents will appear here.'}${isTouch ? '' : '<br>Drop files anywhere on this window to add one.'}</p></div>`;
    return;
  }
  const cat = catOf(item.category);
  const pages = item.pages || [];
  const fields = (item.fields || []).filter((f) => f.value);
  const exp = expiryText(daysUntilExpiry(item));
  el.innerHTML = `<article class="detail">
    <div class="detail-head">
      <button class="btn link back-btn" type="button" data-act="back">${I.back} Vault</button>
      <div class="detail-actions">
        <button class="btn small" type="button" data-act="share">Share</button>
        <button class="btn small" type="button" data-act="edit">Edit</button>
        ${pages.length ? '<button class="btn small primary" type="button" data-act="show">Show</button>' : ''}
      </div>
    </div>
    <h2>${esc(item.title)}</h2>
    <p class="muted">${esc(cat.label)}${exp ? ` · <span class="item-sub warn">${esc(exp)}</span>` : ''}</p>
    ${pages.length
      ? `<div class="pages">${pages.map((p, i) => `<button type="button" class="page-thumb" data-page="${i}" aria-label="Show page ${i + 1} full screen"><img alt="Page ${i + 1} of ${esc(item.title)}" data-blob="${esc(p.id)}" data-type="${esc(p.type)}"></button>`).join('')}</div>`
      : '<div class="no-pages">No scan attached — details only</div>'}
    ${fields.length ? `<div class="kv">${fields.map((f, i) => `<div class="kv-row"><div class="kv-text"><span class="kv-label">${esc(f.label)}</span><span class="kv-value">${esc(f.value)}</span></div>${f.value ? `<button type="button" class="copy-btn" data-copy="${i}">Copy</button>` : ''}</div>`).join('')}</div>` : ''}
    ${(item.tags || []).length ? `<div class="tags">${item.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${item.notes ? `<div class="notes">${esc(item.notes)}</div>` : ''}
    ${(item.originals || []).length ? `<div class="files"><p class="section-label">Original files</p>${item.originals.map((o, i) => `<button type="button" class="btn small" data-orig="${i}">Open ${esc(o.name)}</button>`).join('')}</div>` : ''}
    ${item.text ? `<details class="read-text"><summary>Text read from the document</summary><pre>${esc(item.text)}</pre></details>` : ''}
    <p class="meta-line">Added ${esc(fmtDate(item.created))}${item.updated && item.updated !== item.created ? ` · updated ${esc(fmtDate(item.updated))}` : ''}</p>
    <div><button class="btn small danger" type="button" data-act="delete">Delete this item</button></div>
  </article>`;
  hydrate(el);
}

function selectItem(id) {
  state.selectedId = id;
  for (const b of document.querySelectorAll('#list .item')) b.setAttribute('aria-current', String(b.dataset.id === id));
  renderDetail();
  document.body.classList.add('detail-open');
  $('detail').scrollTop = 0;
}

// ---------- viewer ----------
async function openViewer(item, start = 0) {
  const pages = item.pages || [];
  if (!pages.length) return;
  const v = $('viewer');
  v.classList.remove('handover');
  $('viewer-handover').setAttribute('aria-pressed', 'false');
  $('viewer-handover').textContent = 'Hand over';
  $('viewer-title').textContent = item.title;
  $('viewer-pages').innerHTML = pages
    .map((p, i) => `<div class="viewer-page" data-i="${i}"><img alt="Page ${i + 1} of ${esc(item.title)}" data-blob="${esc(p.id)}" data-type="${esc(p.type)}"></div>`)
    .join('');
  const fields = (item.fields || []).filter((f) => f.label && f.value);
  $('viewer-fields').innerHTML = fields.map((f) => `<div class="vf"><span>${esc(f.label)}</span><strong>${esc(f.value)}</strong></div>`).join('');
  v.hidden = false;
  state.viewerOpen = true;
  updateViewerCount();
  await hydrate($('viewer-pages'));
  const target = $('viewer-pages').children[start];
  if (target) $('viewer-pages').scrollLeft = target.offsetLeft;
  requestWakeLock();
}

function updateViewerCount() {
  const box = $('viewer-pages');
  const n = box.children.length;
  const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
  $('viewer-count').textContent = n > 1 ? `Page ${Math.min(n, i + 1)} of ${n} · swipe for more` : '';
}

function closeViewer() {
  const v = $('viewer');
  if (v.hidden) return;
  v.hidden = true;
  state.viewerOpen = false;
  $('viewer-pages').innerHTML = '';
  closeSharedExtras();
  releaseWakeLock();
  state.lastActivity = Date.now();
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) { /* optional */ }
}

function releaseWakeLock() {
  try { if (state.wakeLock) state.wakeLock.release(); } catch (_) { /* ignore */ }
  state.wakeLock = null;
}

// ---------- copying and opening ----------
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${label || ''}`.trim());
}

async function deliverFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

async function openOriginal(o) {
  try {
    const bytes = await vault.getBlobBytes(o.id);
    const blob = new Blob([bytes], { type: o.type || 'application/octet-stream' });
    if (isTouch) {
      await deliverFile(blob, o.name, o.name);
    } else {
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank', 'noopener');
      if (!w) await deliverFile(blob, o.name, o.name);
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  } catch (err) {
    toast(errText(err), 4000);
  }
}

// ---------- add / edit ----------
function fieldRow(label = '', value = '', auto = false) {
  const row = document.createElement('div');
  row.className = 'field-row' + (auto ? ' auto' : '');
  row.addEventListener('input', () => row.classList.remove('auto'));
  row.innerHTML = `<input aria-label="Field name" placeholder="Name, e.g. IFSC" value="${esc(label)}">
    <input aria-label="Field value" placeholder="Value" value="${esc(value)}" autocapitalize="off" autocomplete="off" spellcheck="false">
    <button type="button" class="icon-btn" aria-label="Remove this field">${I.x}</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}

function setFieldRows(fields) {
  const box = $('edit-fields');
  box.innerHTML = '';
  for (const f of fields) box.appendChild(fieldRow(f.label, f.value));
}

function readFieldRows() {
  return [...$('edit-fields').querySelectorAll('.field-row')]
    .map((r) => {
      const [a, b] = r.querySelectorAll('input');
      return { label: a.value.trim(), value: b.value.trim() };
    })
    .filter((f) => f.value); // a name with no value is just an unused suggestion
}

function openEdit(item, initialFiles = []) {
  cleanupEdit();
  const isNew = !item;
  const base = item
    ? JSON.parse(JSON.stringify(item))
    : { id: vault.newId(), title: '', category: 'identity', tags: [], fields: [], notes: '', pinned: false, pages: [], originals: [] };
  state.edit = { isNew, item: base, removed: new Set(), pending: [], texts: new Map(), readChain: Promise.resolve(), reading: 0, titleAuto: isNew, categoryTouched: !isNew };
  for (const id of ['edit-title', 'edit-category', 'edit-tags']) $(id).classList.remove('auto');
  $('edit-heading').textContent = isNew ? 'New item' : 'Edit item';
  $('edit-title').value = base.title;
  $('edit-category').innerHTML = CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  $('edit-category').value = base.category;
  $('edit-tags').value = (base.tags || []).join(', ');
  $('edit-notes').value = base.notes || '';
  $('edit-pinned').checked = !!base.pinned;
  $('edit-error').textContent = '';
  $('edit-progress').textContent = '';
  setFieldRows(isNew ? catOf(base.category).presets.map((l) => ({ label: l, value: '' })) : base.fields || []);
  $('edit-save').disabled = false;
  $('dlg-edit').showModal();
  updateReadButton();
  if (initialFiles.length) addFiles(initialFiles);
  renderEditThumbs();
  if (!isTouch && !initialFiles.length) $('edit-title').focus();
}

function cleanupEdit() {
  if (!state.edit) return;
  for (const p of state.edit.pending) if (p.preview) URL.revokeObjectURL(p.preview);
  state.edit = null;
  ocr.release();
}

function suggestTitle(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}

function addFiles(fileList) {
  if (!state.edit) return;
  const rejected = [];
  for (const file of fileList) {
    if (!isPdf(file) && !isImage(file)) { rejected.push(file.name); continue; }
    const p = { key: vault.newId(), file, preview: null };
    if (!isPdf(file)) p.preview = URL.createObjectURL(file);
    state.edit.pending.push(p);
    if (!$('edit-title').value.trim()) { $('edit-title').value = suggestTitle(file.name); state.edit.titleAuto = true; }
    queueRead({ key: p.key, file, pending: p });
  }
  $('edit-error').textContent = rejected.length ? `Skipped (not an image or PDF): ${rejected.join(', ')}` : '';
  renderEditThumbs();
  updateReadButton();
}

// ---------- reading details from documents ----------

function updateReadButton() {
  const e = state.edit;
  const btn = $('edit-read');
  if (!e) { btn.hidden = true; return; }
  // Items added before 1.1.2 have no original files kept; their page images are read instead.
  const pages = (e.item.pages || []).filter((p) => !e.removed.has(p.id)).length;
  const any = e.pending.length || (e.item.originals || []).length || pages;
  btn.hidden = !any;
  btn.disabled = e.reading > 0;
}

function queueRead(source) {
  const e = state.edit;
  if (!e) return;
  e.reading++;
  updateReadButton();
  state.busy++;
  e.readChain = e.readChain
    .then(() => readOne(e, source))
    .catch((err) => { if (state.edit === e) $('edit-progress').textContent = errText(err); })
    .finally(() => {
      state.busy--;
      e.reading--;
      if (state.edit === e) updateReadButton();
    });
}

async function readOne(e, { key, file, pending }) {
  if (state.edit !== e) return;
  const progress = (t) => { if (state.edit === e) $('edit-progress').textContent = t; };
  progress(`Reading ${file.name}…`);
  let text = '';
  if (isPdf(file)) {
    const res = await pdfTextOrImage(file, {
      password: pending && pending.pdfPassword,
      askPassword: (msg) => ask({ title: 'Password needed', text: msg, input: 'password', okLabel: 'Open' }),
    });
    if (pending) pending.pdfPassword = res.password;
    text = res.text;
    if (res.firstPage) {
      progress(`Reading ${file.name} (scanned page)…`);
      text = await ocr.recognise(res.firstPage, (f) => progress(`Reading ${file.name}… ${Math.round(f * 100)}%`));
    }
  } else {
    const canvas = await imageForOcr(file);
    text = await ocr.recognise(canvas, (f) => progress(`Reading ${file.name}… ${Math.round(f * 100)}%`));
  }
  if (state.edit !== e) return;
  e.texts.set(key, text);
  const all = [...e.texts.values()].join('\n');
  applyExtraction(extractDetails(all));
}

function markAuto(el) { el.classList.add('auto'); }

function applyExtraction(r) {
  const e = state.edit;
  if (!e) return;
  const found = r.fields.length;
  if (!found && r.kind === 'other') {
    $('edit-progress').textContent = 'No details recognised. Fill them in yourself, or try a sharper photo.';
    return;
  }
  if (r.title && (e.titleAuto || !$('edit-title').value.trim())) {
    $('edit-title').value = r.title;
    e.titleAuto = true;
    markAuto($('edit-title'));
  }
  if (r.category && !e.categoryTouched) {
    $('edit-category').value = r.category;
    markAuto($('edit-category'));
  }
  // Merge fields: fill empty matching rows, add new ones, drop unused empty suggestions.
  const box = $('edit-fields');
  const rows = () => [...box.querySelectorAll('.field-row')].map((row) => {
    const [a, b] = row.querySelectorAll('input');
    return { row, a, b };
  });
  for (const f of r.fields) {
    const match = rows().find((x) => x.a.value.trim().toLowerCase() === f.label.toLowerCase());
    if (match) {
      // Empty, auto-filled, or a placeholder such as "0" or "-" is replaced.
      if (/^[\s0.\-–—_?]{0,2}$/.test(match.b.value) || match.row.classList.contains('auto')) {
        match.b.value = f.value;
        match.row.classList.add('auto');
      }
    } else {
      box.appendChild(fieldRow(f.label, f.value, true));
    }
  }
  if (found) for (const x of rows()) if (!x.b.value.trim() && !x.a.matches(':focus')) x.row.remove();
  // Tags
  const tags = $('edit-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
  const merged = [...new Set([...tags, ...r.tags])];
  if (merged.length !== tags.length) { $('edit-tags').value = merged.join(', '); markAuto($('edit-tags')); }
  const unsure = r.fields.filter((f) => !f.sure).length;
  $('edit-progress').textContent = found
    ? `Found ${found} detail${found === 1 ? '' : 's'} — highlighted below. Check them${unsure ? ', especially names and branch' : ''} — nothing is saved until you press Save.`
    : 'Recognised the document type but no details. Fill them in yourself.';
}

async function readStoredOriginals() {
  const e = state.edit;
  if (!e) return;
  if (e.pending.length) {
    for (const p of e.pending) queueRead({ key: p.key, file: p.file, pending: p });
    return;
  }
  let queued = 0;
  for (const o of e.item.originals || []) {
    if (!/pdf|image/i.test(o.type || '') && !/\.(pdf|jpe?g|png|heic|heif|webp)$/i.test(o.name)) continue;
    const bytes = await vault.getBlobBytes(o.id);
    const file = new File([bytes], o.name, { type: o.type || '' });
    queueRead({ key: 'orig-' + o.id, file, pending: null });
    queued++;
  }
  if (queued) return;
  // No original kept (items added before 1.1.2): read the stored page images.
  const pages = (e.item.pages || []).filter((p) => !e.removed.has(p.id));
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const type = p.type || 'image/jpeg';
    const bytes = await vault.getBlobBytes(p.id);
    const file = new File([bytes], `page-${i + 1}.${/png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg'}`, { type });
    queueRead({ key: 'page-' + p.id, file, pending: null });
  }
}

function renderEditThumbs() {
  const e = state.edit;
  if (!e) return;
  const existing = (e.item.pages || []).filter((p) => !e.removed.has(p.id));
  const html = [
    ...existing.map((p, i) => `<div class="thumb"><img alt="Page ${i + 1}" data-blob="${esc(p.id)}" data-type="${esc(p.type)}"><button type="button" data-remove-page="${esc(p.id)}" aria-label="Remove page ${i + 1}">${I.x}</button></div>`),
    ...e.pending.map((p) => p.preview
      ? `<div class="thumb"><img alt="${esc(p.file.name)}" src="${esc(p.preview)}"><button type="button" data-remove-pending="${p.key}" aria-label="Remove ${esc(p.file.name)}">${I.x}</button></div>`
      : `<div class="thumb"><div class="pdf-thumb">PDF<br>${esc(p.file.name)}</div><button type="button" data-remove-pending="${p.key}" aria-label="Remove ${esc(p.file.name)}">${I.x}</button></div>`),
  ].join('');
  $('edit-thumbs').innerHTML = html;
  hydrate($('edit-thumbs'));
}

async function saveEdit() {
  const e = state.edit;
  if (!e) return;
  const title = $('edit-title').value.trim();
  if (!title) { $('edit-error').textContent = 'Give it a title, such as “Passport”.'; return; }
  $('edit-save').disabled = true;
  $('edit-error').textContent = '';
  state.busy++;
  try {
    if (e.reading) {
      $('edit-progress').textContent = 'Finishing reading the document…';
      await e.readChain;
    }
    const newBlobs = [];
    const newPages = [];
    const newOriginals = [];
    let note = '';
    for (const p of e.pending) {
      const file = p.file;
      const originalId = vault.newId();
      let rendered;
      $('edit-progress').textContent = `Preparing ${file.name}…`;
      if (isPdf(file)) {
        const res = await pdfToPages(file, {
          password: p.pdfPassword,
          askPassword: (text) => ask({ title: 'Password needed', text, input: 'password', okLabel: 'Open' }),
          onProgress: (i, n) => { $('edit-progress').textContent = `Preparing ${file.name}: page ${i} of ${n}`; },
        });
        rendered = res.pages;
        if (res.truncated) note = `Only the first ${MAX_PDF_PAGES} of ${res.totalPages} pages of ${file.name} are shown; the full PDF is kept as the original.`;
      } else {
        rendered = [await imageToPage(file)];
      }
      newBlobs.push({ id: originalId, bytes: await file.arrayBuffer() });
      newOriginals.push({ id: originalId, name: file.name, type: file.type || (isPdf(file) ? 'application/pdf' : 'application/octet-stream'), size: file.size });
      for (const r of rendered) {
        const id = vault.newId();
        newBlobs.push({ id, bytes: r.bytes });
        newPages.push({ id, type: r.type, width: r.width, height: r.height, source: originalId });
      }
    }
    const keptPages = (e.item.pages || []).filter((p) => !e.removed.has(p.id));
    const pages = [...keptPages, ...newPages];
    const stillUsed = new Set(pages.map((p) => p.source));
    const keptOriginals = (e.item.originals || []).filter((o) => stillUsed.has(o.id));
    const droppedOriginals = (e.item.originals || []).filter((o) => !stillUsed.has(o.id)).map((o) => o.id);
    const tags = [...new Set($('edit-tags').value.split(',').map((t) => t.trim()).filter(Boolean))];
    const item = {
      ...e.item,
      title,
      category: $('edit-category').value,
      tags,
      fields: readFieldRows(),
      notes: $('edit-notes').value.trim(),
      pinned: $('edit-pinned').checked,
      text: e.texts.size ? [...e.texts.values()].join('\n').slice(0, 20000) : (e.item.text || ''),
      pages,
      originals: [...keptOriginals, ...newOriginals],
    };
    $('edit-progress').textContent = 'Encrypting and saving…';
    const saved = await vault.saveItem(item, newBlobs, [...e.removed, ...droppedOriginals]);
    for (const id of e.removed) {
      const u = state.urls.get(id);
      if (u) { URL.revokeObjectURL(u); state.urls.delete(id); }
    }
    const idx = state.items.findIndex((i) => i.id === saved.id);
    if (idx >= 0) state.items[idx] = saved;
    else state.items.push(saved);
    state.selectedId = saved.id;
    $('dlg-edit').close();
    cleanupEdit();
    render();
    if (!isWide()) document.body.classList.add('detail-open');
    toast(note || 'Saved', note ? 6000 : 2000);
  } catch (err) {
    $('edit-error').textContent = errText(err);
    $('edit-progress').textContent = '';
  } finally {
    state.busy--;
    $('edit-save').disabled = false;
  }
}

// ---------- backup / restore ----------
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function remember(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* optional */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

async function exportBackup() {
  state.busy++;
  try {
    const blob = await vault.exportBackup(APP_VERSION);
    const ok = await deliverFile(blob, `pocket-vault-backup-${today()}.json`, 'Pocket Vault backup');
    if (ok) {
      remember('pv-last-backup', new Date().toISOString());
      toast('Backup saved. Keep it in iCloud Drive or on your Mac.', 3500);
      fillAbout();
    }
    return ok;
  } catch (err) {
    toast(errText(err), 4000);
    return false;
  } finally {
    state.busy--;
  }
}

function pickBackupFile() {
  return new Promise((resolve) => {
    const input = $('file-backup');
    input.value = '';
    const onChange = () => { input.removeEventListener('change', onChange); resolve(input.files[0] || null); };
    input.addEventListener('change', onChange);
    input.click();
  });
}

async function restoreFlow() {
  const file = await pickBackupFile();
  if (!file) return;
  let backup;
  try {
    backup = await vault.readBackupFile(file);
  } catch (err) {
    await ask({ title: 'Cannot restore', text: errText(err), noCancel: true });
    return;
  }
  const when = backup.exported ? fmtDate(backup.exported) : 'an unknown date';
  let error = '';
  let secret = null;
  for (;;) {
    secret = await ask({
      title: 'Open the backup',
      text: `Backup from ${when} with ${backup.itemCount ?? backup.items.length} item(s). Enter the passphrase or recovery code that was in use when it was made.`,
      input: 'password',
      okLabel: 'Check',
      error,
    });
    if (secret == null) return;
    try {
      await vault.checkBackupSecret(backup, secret);
      break;
    } catch (_) {
      error = 'That did not open the backup. Try again.';
    }
  }
  const hasVault = await vault.isSetUp();
  if (hasVault) {
    const current = vault.isUnlocked() ? state.items.length : 'all';
    const sure = await ask({
      title: 'Replace this device’s vault?',
      text: `Everything now on this device (${current} item${current === 1 ? '' : 's'}) will be replaced by the backup. This cannot be undone.`,
      okLabel: 'Replace',
      danger: true,
    });
    if (!sure) return;
  }
  state.busy++;
  try {
    lockSilently();
    await vault.restoreBackup(backup, secret);
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    await enterApp();
    toast('Backup restored.', 3000);
  } catch (err) {
    await ask({ title: 'Restore failed', text: errText(err), noCancel: true });
  } finally {
    state.busy--;
  }
}

function lockSilently() {
  vault.lock();
  revokeAll();
  state.items = [];
}

// ---------- settings ----------
async function fillAbout() {
  const est = await vault.storageEstimate();
  let persisted = 'Unknown';
  try { if (navigator.storage && navigator.storage.persisted) persisted = (await navigator.storage.persisted()) ? 'Yes' : 'Not granted'; } catch (_) { /* ignore */ }
  const used = est && est.usage != null ? `${(est.usage / 1048576).toFixed(1)} MB` : 'Unknown';
  const last = recall('pv-last-backup');
  const offline = navigator.serviceWorker && navigator.serviceWorker.controller ? 'Ready' : 'Not yet — open the app once more while online';
  const rows = [
    ['Version', APP_VERSION],
    ['Items', String(state.items.length)],
    ['Space used', used],
    ['Protected from clean-up', persisted],
    ['Works offline', offline],
    ['Last backup (this device)', last ? fmtDate(last) : 'Never'],
  ];
  $('about').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

// ---------- voice ----------
function voice() {
  const input = $('q');
  const hint = $('voice-hint');
  const showHint = (text) => {
    hint.textContent = text;
    hint.hidden = false;
    setTimeout(() => { hint.hidden = true; }, 7000);
  };
  input.focus();
  if (isTouch) {
    showHint('Tap the microphone on your keyboard and say what you need, e.g. “passport”.');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const fallback = 'Press the microphone key (F5) on your keyboard and say what you need, e.g. “passport”.';
  if (!SR) { showHint(fallback); return; }
  try {
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    showHint('Listening… say what you need.');
    rec.onresult = (ev) => {
      const text = ev.results[0][0].transcript;
      input.value = text;
      state.query = text;
      renderList();
      hint.hidden = true;
      const top = visibleItems()[0];
      if (top) selectItem(top.id);
    };
    rec.onerror = () => showHint(fallback);
    rec.start();
  } catch (_) {
    showHint(fallback);
  }
}

// ---------- service worker and updates ----------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (state.updateRequested) location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
    });
  }).catch((err) => console.warn('Offline support unavailable:', err));
}

function offerUpdate(worker) {
  state.updateWorker = worker;
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => {
    if (ev.data && ev.data.version) $('update-text').textContent = `Version ${ev.data.version} is ready.`;
  };
  try { worker.postMessage({ type: 'GET_VERSION' }, [ch.port2]); } catch (_) { /* ignore */ }
  showUpdateBanner();
}

function showUpdateBanner() {
  $('update-banner').hidden = !state.updateWorker;
}

// ---------- activity and auto-lock ----------
function touchActivity() { state.lastActivity = Date.now(); }

setInterval(() => {
  if (!vault.isUnlocked() || state.busy || state.viewerOpen) return;
  if (Date.now() - state.lastActivity > AUTO_LOCK_MS) lockNow();
}, 15000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    state.hiddenAt = Date.now();
    releaseWakeLock();
  } else {
    if (vault.isUnlocked() && !state.busy && state.hiddenAt && Date.now() - state.hiddenAt > HIDDEN_LOCK_MS) lockNow();
    else if (state.viewerOpen) requestWakeLock();
    state.hiddenAt = null;
    touchActivity();
  }
});


// ---------- sharing ----------
// Two steps: Prepare (slow work) then Send (must run inside a fresh tap,
// because browsers only open the share sheet straight after a user gesture).

const SHARE_LINK = 'https://vidyadhar-mudkavi.github.io/pocket-vault/';

function shareMode() { return document.querySelector('input[name="share-mode"]:checked').value; }
function shareFormat() { return document.querySelector('input[name="share-format"]:checked').value; }

function watermarkText() {
  const who = $('share-for').value.trim();
  const why = $('share-purpose').value.trim();
  const parts = [who ? `Copy for ${who}` : 'Copy'];
  if (why) parts.push(`for ${why} only`);
  parts.push(share.todayLabel());
  return parts.join(' · ');
}

function chosenFields() {
  const item = state.share && state.share.item;
  if (!item) return [];
  const fields = (item.fields || []).filter((f) => f.value);
  return [...$('share-fields').querySelectorAll('input[type=checkbox]')]
    .filter((c) => c.checked)
    .map((c) => fields[+c.dataset.i]);
}

function refreshShareForm() {
  const sh = state.share;
  if (!sh) return;
  const secure = shareMode() === 'secure';
  const hasPages = (sh.item.pages || []).length > 0;
  const pagesOn = hasPages && $('share-pages').checked;
  const origs = sh.item.originals || [];
  $('share-format-row').hidden = secure || !pagesOn;
  $('share-format-orig').hidden = !origs.length;
  if (!origs.length && shareFormat() === 'original') document.querySelector('input[name="share-format"][value="pdf"]').checked = true;
  const sendingOriginals = !secure && pagesOn && shareFormat() === 'original';
  $('share-orig-secure-row').hidden = !(secure && pagesOn && origs.length);
  const names = origs.map((o) => o.name).join(', ');
  const protectedPdf = origs.some((o) => /pdf/i.test(o.type || o.name));
  $('share-orig-hint').textContent = (sendingOriginals || (secure && $('share-orig-secure').checked && origs.length))
    ? `Exactly as added: ${names}.${protectedPdf ? ' A password-protected PDF stays protected.' : ''} No watermark on originals.`
    : '';
  $('share-wm').hidden = !pagesOn || sendingOriginals;
  const wmOn = $('share-wm-on').checked;
  $('share-wm-fields').hidden = !wmOn;
  $('share-wm-preview').textContent = wmOn ? `Stamp: “${watermarkText()}”` : '';
  const anyAadhaar = (sh.item.fields || []).some((f) => f.value && share.looksLikeAadhaar(f));
  $('share-mask-row').hidden = !anyAadhaar;
  $('share-note').textContent = secure
    ? 'The recipient opens the file in Pocket Vault at ' + SHARE_LINK + ' (no vault needed) and types the code.'
    : 'The copy you send is not encrypted once it leaves this app. Delete it from the chat after use.';
  $('share-ready').hidden = true;
  sh.prepared = null;
}

function openShare(item) {
  state.share = { item, prepared: null };
  $('share-heading').textContent = `Share: ${item.title}`;
  const nPages = (item.pages || []).length;
  $('share-pages').checked = nPages > 0;
  $('share-pages').disabled = nPages === 0;
  $('share-pages-label').textContent = nPages ? `Pages (${nPages})` : 'No pages — details only';
  const fields = (item.fields || []).filter((f) => f.value);
  $('share-fields').innerHTML = fields.length
    ? fields.map((f, i) => `<label class="check"><input type="checkbox" data-i="${i}" checked> ${esc(f.label || 'Detail')}: <span class="share-val">${esc(f.value)}</span></label>`).join('')
    : '<p class="hint indent">No details to include.</p>';
  $('share-error').textContent = '';
  document.querySelector('input[name="share-mode"][value="normal"]').checked = true;
  document.querySelector('input[name="share-format"][value="pdf"]').checked = true;
  $('share-wm-on').checked = false;
  $('share-orig-secure').checked = false;
  $('share-mask').checked = true;
  refreshShareForm();
  $('dlg-share').showModal();
}

async function prepareShare() {
  const sh = state.share;
  if (!sh) return;
  const item = sh.item;
  const secure = shareMode() === 'secure';
  const includePages = $('share-pages').checked && (item.pages || []).length > 0;
  const fields = chosenFields();
  if (!includePages && !fields.length) { $('share-error').textContent = 'Choose pages or at least one detail.'; return; }
  const mask = $('share-mask').checked;
  const useOriginals = includePages && !secure && shareFormat() === 'original';
  const addOriginals = includePages && secure && $('share-orig-secure').checked;
  const wm = includePages && !useOriginals && $('share-wm-on').checked ? watermarkText() : null;
  const btn = $('share-prepare');
  btn.disabled = true;
  $('share-error').textContent = '';
  state.busy++;
  try {
    const pages = [];
    const originals = [];
    if (useOriginals || addOriginals) {
      for (const o of item.originals || []) {
        btn.textContent = `Reading ${o.name}…`;
        originals.push({ name: o.name, type: o.type || 'application/octet-stream', bytes: new Uint8Array(await vault.getBlobBytes(o.id)) });
      }
    }
    if (includePages && !useOriginals) {
      for (let i = 0; i < item.pages.length; i++) {
        btn.textContent = `Preparing page ${i + 1} of ${item.pages.length}…`;
        const bytes = await vault.getBlobBytes(item.pages[i].id);
        pages.push(await share.preparePage(bytes, wm));
      }
    }
    const text = fields.length ? share.detailsText(item.title, fields, { mask }) : '';
    const outFields = fields.map((f) => ({ label: f.label, value: mask && share.looksLikeAadhaar(f) ? share.maskAadhaar(f.value) : f.value }));
    const base = share.safeFileName(item.title);
    const prepared = { files: [], text, code: null, label: '' };
    if (secure) {
      btn.textContent = 'Encrypting…';
      const code = share.newShareCode();
      const blob = await share.makePackage({ title: item.title, note: wm || '', fields: outFields, pages, originals }, code);
      prepared.files.push(new File([blob], `${base}.secure.json`, { type: 'application/json' }));
      prepared.code = share.formatShareCode(code);
      prepared.text = `Secure document from Pocket Vault: “${item.title}”. Open ${SHARE_LINK} → “Open a shared document”, choose this file, and enter the code I send you separately.`;
      prepared.label = `Secure package ready (${(blob.size / 1048576).toFixed(1)} MB). Pages and details are inside it.`;
    } else {
      if (useOriginals) {
        originals.forEach((o) => prepared.files.push(new File([o.bytes], o.name, { type: o.type })));
      } else if (pages.length) {
        if (shareFormat() === 'pdf') {
          const pdf = share.buildPdf(pages, item.title);
          prepared.files.push(new File([pdf], `${base}.pdf`, { type: 'application/pdf' }));
        } else {
          pages.forEach((p, i) => prepared.files.push(new File([p.bytes], `${base}${pages.length > 1 ? '-' + (i + 1) : ''}.jpg`, { type: 'image/jpeg' })));
        }
      }
      const size = prepared.files.reduce((a, f) => a + f.size, 0);
      prepared.label = prepared.files.length
        ? `Ready: ${prepared.files.length} file${prepared.files.length > 1 ? 's' : ''} (${(size / 1048576).toFixed(1)} MB).${text ? ' Send it, then use Copy details and paste them into the same chat.' : ''}`
        : 'Details ready as text.';
    }
    sh.prepared = prepared;
    $('share-ready-text').textContent = prepared.label;
    $('share-code-box').hidden = !prepared.code;
    $('share-code').textContent = prepared.code || '';
    $('share-copy-text').hidden = !text || secure;
    $('share-save').hidden = !prepared.files.length;
    $('share-ready').hidden = false;
    $('share-ready').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    $('share-error').textContent = errText(err);
  } finally {
    state.busy--;
    btn.disabled = false;
    btn.textContent = 'Prepare';
  }
}

async function sendShare() {
  const p = state.share && state.share.prepared;
  if (!p) return;
  // Files go alone: more apps accept a single file than file + text, and some
  // (WhatsApp) drop the text anyway. Details travel via "Copy details".
  const data = p.files.length ? { files: p.files } : { text: p.text, title: state.share.item.title };
  try {
    if (navigator.share && (!data.files || (navigator.canShare && navigator.canShare({ files: data.files })))) {
      await navigator.share(data);
      toast(p.code ? 'Sent. Now give the code by phone or SMS.' : 'Shared.', 4000);
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  // No share sheet available: save the file(s) and copy the text instead.
  saveShareFiles();
  if (p.text && !p.code) await copyText(p.text, 'details');
}

function saveShareFiles() {
  const p = state.share && state.share.prepared;
  if (!p) return;
  for (const f of p.files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  toast(p.files.length > 1 ? 'Files saved to Downloads.' : 'File saved to Downloads.', 3000);
}

// ---------- opening a shared package ----------

function pickShareFile() {
  return new Promise((resolve) => {
    const input = $('file-share-pkg');
    input.value = '';
    const onChange = () => { input.removeEventListener('change', onChange); resolve(input.files[0] || null); };
    input.addEventListener('change', onChange);
    input.click();
  });
}

function openSharedDialog() {
  if ($('dlg-settings').open) $('dlg-settings').close();
  state.sharedPkg = null;
  $('open-share-file').textContent = 'No file chosen.';
  $('open-share-code').value = '';
  $('open-share-error').textContent = '';
  $('dlg-open-share').showModal();
}

function showSharedViewer(payload) {
  const v = $('viewer');
  v.classList.remove('handover');
  $('viewer-handover').setAttribute('aria-pressed', 'false');
  $('viewer-handover').textContent = 'Hand over';
  $('viewer-title').textContent = `${payload.title} (shared)`;
  const urls = payload.pages.map((p) => URL.createObjectURL(new Blob([p.bytes], { type: p.type || 'image/jpeg' })));
  state.sharedUrls = urls;
  $('viewer-pages').innerHTML = urls.length
    ? urls.map((u, i) => `<div class="viewer-page"><img alt="Page ${i + 1} of ${esc(payload.title)}" src="${esc(u)}"></div>`).join('')
    : '<div class="viewer-page"><p class="shared-note">No pages — details below.</p></div>';
  const fields = (payload.fields || []).filter((f) => f.value);
  const sent = payload.created ? ` · sent ${fmtDate(payload.created)}` : '';
  $('viewer-fields').innerHTML =
    fields.map((f, i) => `<div class="vf"><span>${esc(f.label)}</span><strong>${esc(f.value)}</strong> <button type="button" class="copy-btn" data-shared-copy="${i}">Copy</button></div>`).join('') +
    `<div class="vf"><span>Shared document${esc(sent)}</span><button type="button" class="copy-btn" id="shared-save-pages">Save pages</button></div>` +
    (payload.originals || []).map((o, i) => `<div class="vf"><span>Original file</span><button type="button" class="copy-btn" data-shared-orig="${i}">Save ${esc(o.name)}</button></div>`).join('');
  state.sharedPayload = payload;
  v.hidden = false;
  state.viewerOpen = true;
  updateViewerCount();
  requestWakeLock();
}

function closeSharedExtras() {
  if (state.sharedUrls) { for (const u of state.sharedUrls) URL.revokeObjectURL(u); }
  state.sharedUrls = null;
  state.sharedPayload = null;
}

// ---------- wiring ----------
function wire() {
  for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
    document.addEventListener(ev, touchActivity, { passive: true, capture: true });
  }

  // Setup
  $('form-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = $('setup-pass').value;
    const p2 = $('setup-pass2').value;
    const err = $('setup-error');
    err.textContent = '';
    if (p1.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (p1 !== p2) { err.textContent = 'The two entries do not match.'; return; }
    const btn = $('setup-submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const code = await vault.setup(p1);
      state.pendingRecovery = code;
      $('recovery-code').textContent = vault.formatRecoveryCode(code);
      $('recovery-ack').checked = false;
      $('recovery-done').disabled = true;
      show('screen-recovery');
    } catch (ex) {
      err.textContent = errText(ex);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create my vault';
    }
  });
  $('setup-restore').addEventListener('click', restoreFlow);

  // Recovery code screen
  $('recovery-copy').addEventListener('click', () => copyText($('recovery-code').textContent, 'recovery code'));
  $('recovery-print').addEventListener('click', () => window.print());
  $('recovery-ack').addEventListener('change', (e) => { $('recovery-done').disabled = !e.target.checked; });
  $('recovery-done').addEventListener('click', async () => {
    state.pendingRecovery = null;
    $('recovery-code').textContent = '';
    $('setup-pass').value = '';
    $('setup-pass2').value = '';
    await enterApp();
  });

  // Unlock
  $('form-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('unlock-submit');
    const err = $('unlock-error');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    try {
      const via = await vault.unlock($('unlock-pass').value);
      $('unlock-pass').value = '';
      await enterApp();
      if (via === 'recovery') {
        await ask({
          title: 'That was the recovery code',
          text: 'The vault opened, but the box held your recovery code, not the passphrase. The Passwords app may have saved the recovery code by mistake. Open the Passwords app, find the entry for this site, and put the passphrase back. Next time, use “Forgot the passphrase? Use the recovery code” for the code.',
          okLabel: 'Understood',
          noCancel: true,
        });
      }
    } catch (ex) {
      err.textContent = 'That passphrase did not open the vault. Check the Passwords app entry, or use the recovery code below.';
      $('unlock-pass').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  });

  // Unlock with the recovery code: a separate form so Safari never offers to
  // save the recovery code over the passphrase in the Passwords app.
  $('unlock-toggle').addEventListener('click', () => setUnlockMode($('form-recovery-unlock').hidden));
  $('form-recovery-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('recovery-unlock-submit');
    const err = $('recovery-unlock-error');
    err.textContent = '';
    const code = $('unlock-recovery').value;
    if (!vault.looksLikeRecoveryCode(code)) { err.textContent = 'A recovery code has 24 letters and digits, in six groups of four.'; return; }
    btn.disabled = true;
    try {
      await vault.unlock(code);
      $('unlock-recovery').value = '';
      await enterApp();
      toast('Opened with the recovery code. If the passphrase is lost, set a new one in Settings.', 6000);
    } catch (ex) {
      err.textContent = 'That recovery code did not open the vault.';
    } finally {
      btn.disabled = false;
    }
  });

  // List pane
  $('btn-lock').addEventListener('click', lockNow);
  $('btn-add').addEventListener('click', () => openEdit(null));
  $('btn-voice').addEventListener('click', voice);
  $('q').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
  $('form-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const top = visibleItems()[0];
    if (state.query.trim() && top) {
      $('q').blur();
      selectItem(top.id);
    }
  });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.category = b.dataset.cat;
    renderChips();
    renderList();
  });
  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (b) selectItem(b.dataset.id);
  });

  // Detail pane
  $('detail').addEventListener('click', async (e) => {
    const item = selected();
    if (!item) return;
    const act = e.target.closest('[data-act]');
    const page = e.target.closest('[data-page]');
    const copy = e.target.closest('[data-copy]');
    const orig = e.target.closest('[data-orig]');
    if (page) return openViewer(item, +page.dataset.page);
    if (copy) {
      const f = (item.fields || []).filter((x) => x.value)[+copy.dataset.copy];
      if (f) copyText(f.value, f.label);
      return;
    }
    if (orig) return openOriginal(item.originals[+orig.dataset.orig]);
    if (!act) return;
    switch (act.dataset.act) {
      case 'back':
        document.body.classList.remove('detail-open');
        break;
      case 'show':
        openViewer(item, 0);
        break;
      case 'edit':
        openEdit(item);
        break;
      case 'share':
        openShare(item);
        break;
      case 'delete': {
        const sure = await ask({ title: `Delete “${item.title}”?`, text: 'Its scans and details will be removed from this device. Backups you made earlier still contain it.', okLabel: 'Delete', danger: true });
        if (!sure) return;
        try {
          await vault.deleteItem(item);
          state.items = state.items.filter((i) => i.id !== item.id);
          state.selectedId = null;
          document.body.classList.remove('detail-open');
          render();
          toast('Deleted');
        } catch (err) {
          toast(errText(err), 4000);
        }
        break;
      }
      default:
    }
  });

  // Viewer
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-handover').addEventListener('click', () => {
    const v = $('viewer');
    const on = !v.classList.contains('handover');
    v.classList.toggle('handover', on);
    $('viewer-handover').setAttribute('aria-pressed', String(on));
    $('viewer-handover').textContent = on ? 'Done handing over' : 'Hand over';
  });
  $('viewer-pages').addEventListener('scroll', updateViewerCount, { passive: true });
  $('viewer-pages').addEventListener('click', (e) => {
    if ($('viewer').classList.contains('handover')) return;
    const pageEl = e.target.closest('.viewer-page');
    if (pageEl && e.target.tagName === 'IMG') pageEl.classList.toggle('zoomed');
  });

  // Edit sheet
  $('edit-cancel').addEventListener('click', () => { $('dlg-edit').close(); cleanupEdit(); });
  $('dlg-edit').addEventListener('cancel', () => cleanupEdit());
  $('form-edit').addEventListener('submit', (e) => { e.preventDefault(); saveEdit(); });
  $('edit-add-field').addEventListener('click', () => {
    const row = fieldRow();
    $('edit-fields').appendChild(row);
    row.querySelector('input').focus();
  });
  $('edit-title').addEventListener('input', () => { if (state.edit) state.edit.titleAuto = false; $('edit-title').classList.remove('auto'); });
  $('edit-tags').addEventListener('input', () => $('edit-tags').classList.remove('auto'));
  $('edit-read').addEventListener('click', readStoredOriginals);
  $('edit-category').addEventListener('change', (e) => {
    if (state.edit) state.edit.categoryTouched = true;
    $('edit-category').classList.remove('auto');
    if (!readFieldRows().length) {
      setFieldRows(catOf(e.target.value).presets.map((l) => ({ label: l, value: '' })));
    }
  });
  for (const id of ['file-pick', 'file-camera']) {
    $(id).addEventListener('change', (e) => {
      addFiles([...e.target.files]);
      e.target.value = '';
    });
  }
  $('edit-thumbs').addEventListener('click', (e) => {
    const rp = e.target.closest('[data-remove-page]');
    const rq = e.target.closest('[data-remove-pending]');
    if (rp && state.edit) state.edit.removed.add(rp.dataset.removePage);
    if (rq && state.edit) {
      const p = state.edit.pending.find((x) => x.key === rq.dataset.removePending);
      if (p && p.preview) URL.revokeObjectURL(p.preview);
      state.edit.pending = state.edit.pending.filter((x) => x.key !== rq.dataset.removePending);
      state.edit.texts.delete(rq.dataset.removePending);
    }
    if (rp || rq) renderEditThumbs();
  });

  // Drag and drop: anywhere on the unlocked app
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !vault.isUnlocked()) return;
    e.preventDefault();
    dragDepth++;
    if ($('dlg-edit').open) $('drop-zone').classList.add('over');
    else if (!document.querySelector('dialog[open]')) $('drop-overlay').hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = vault.isUnlocked() ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { $('drop-overlay').hidden = true; $('drop-zone').classList.remove('over'); }
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    $('drop-zone').classList.remove('over');
    if (!vault.isUnlocked()) return;
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if ($('dlg-edit').open) addFiles(files);
    else if (!document.querySelector('dialog[open]')) openEdit(null, files);
  });

  // Settings
  $('btn-settings').addEventListener('click', () => {
    $('change-pass-error').textContent = '';
    $('dlg-settings').showModal();
    fillAbout();
  });
  $('settings-close').addEventListener('click', () => $('dlg-settings').close());
  $('btn-export').addEventListener('click', exportBackup);
  $('btn-restore').addEventListener('click', restoreFlow);
  $('form-change-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('new-pass').value;
    const b = $('new-pass2').value;
    const err = $('change-pass-error');
    err.textContent = '';
    if (a.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (a !== b) { err.textContent = 'The two entries do not match.'; return; }
    try {
      await vault.changePassphrase(a);
      $('new-pass').value = '';
      $('new-pass2').value = '';
      toast('Passphrase changed. Make sure the Passwords app has the new one.', 5000);
    } catch (ex) {
      err.textContent = errText(ex);
    }
  });
  $('btn-new-recovery').addEventListener('click', async () => {
    const sure = await ask({ title: 'Make a new recovery code?', text: 'The current code will stop working on this device.', okLabel: 'Make new code' });
    if (!sure) return;
    try {
      const code = await vault.newRecoveryCode();
      await ask({
        title: 'Your new recovery code',
        text: 'Shown only now. Print it or write it down, and destroy the old one. Then export a fresh backup.',
        code: vault.formatRecoveryCode(code),
        okLabel: 'I have saved it',
        noCancel: true,
      });
    } catch (ex) {
      toast(errText(ex), 4000);
    }
  });

  // Share dialog
  $('share-cancel').addEventListener('click', () => { $('dlg-share').close(); state.share = null; });
  $('dlg-share').addEventListener('close', () => { state.share = null; });
  $('form-share').addEventListener('submit', (e) => { e.preventDefault(); prepareShare(); });
  $('form-share').addEventListener('change', (e) => { if (e.target.id !== 'share-for' && e.target.id !== 'share-purpose') refreshShareForm(); });
  for (const id of ['share-for', 'share-purpose']) $(id).addEventListener('input', refreshShareForm);
  $('share-send').addEventListener('click', sendShare);
  $('share-save').addEventListener('click', saveShareFiles);
  $('share-copy-code').addEventListener('click', () => copyText($('share-code').textContent, 'share code'));
  $('share-copy-text').addEventListener('click', () => {
    const p = state.share && state.share.prepared;
    if (p && p.text) copyText(p.text, 'details');
  });

  // Open a shared document (works with or without a vault on this device)
  for (const id of ['setup-open-share', 'unlock-open-share', 'settings-open-share']) $(id).addEventListener('click', openSharedDialog);
  $('open-share-cancel').addEventListener('click', () => $('dlg-open-share').close());
  $('open-share-pick').addEventListener('click', async () => {
    const file = await pickShareFile();
    if (!file) return;
    $('open-share-error').textContent = '';
    try {
      state.sharedPkg = await share.readPackageFile(file);
      $('open-share-file').textContent = `File: ${file.name}`;
      $('open-share-code').focus();
    } catch (err) {
      state.sharedPkg = null;
      $('open-share-file').textContent = 'No file chosen.';
      $('open-share-error').textContent = errText(err);
    }
  });
  $('form-open-share').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('open-share-error');
    err.textContent = '';
    if (!state.sharedPkg) { err.textContent = 'Choose the file first.'; return; }
    const btn = $('open-share-ok');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      const payload = await share.openPackage(state.sharedPkg, $('open-share-code').value);
      $('dlg-open-share').close();
      state.sharedPkg = null;
      showSharedViewer(payload);
    } catch (ex) {
      err.textContent = errText(ex);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Open';
    }
  });
  $('viewer-fields').addEventListener('click', async (e) => {
    const payload = state.sharedPayload;
    if (!payload) return;
    const c = e.target.closest('[data-shared-copy]');
    if (c) {
      const f = payload.fields.filter((x) => x.value)[+c.dataset.sharedCopy];
      if (f) copyText(f.value, f.label);
      return;
    }
    const so = e.target.closest('[data-shared-orig]');
    if (so) {
      const o = payload.originals[+so.dataset.sharedOrig];
      if (o) await deliverFile(new Blob([o.bytes], { type: o.type }), o.name, o.name);
      return;
    }
    if (e.target.id === 'shared-save-pages') {
      if (!payload.pages.length) { toast('No pages in this document.'); return; }
      const base = share.safeFileName(payload.title);
      const pdf = share.buildPdf(payload.pages, payload.title);
      await deliverFile(pdf, `${base}.pdf`, payload.title);
    }
  });

  // Update banner
  $('update-backup').addEventListener('click', exportBackup);
  $('update-apply').addEventListener('click', () => {
    if (!state.updateWorker) return;
    state.updateRequested = true;
    state.updateWorker.postMessage({ type: 'SKIP_WAITING' });
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.viewerOpen && !$('viewer').classList.contains('handover')) { closeViewer(); return; }
    if ($('screen-app').hidden || document.querySelector('dialog[open]') || state.viewerOpen) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.key === 'f' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      $('q').focus();
      $('q').select();
    }
  });
}

boot();
