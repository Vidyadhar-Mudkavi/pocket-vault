// Pocket Vault — encrypted storage.
//
// Design
// ------
// * One random 256-bit data key (DEK) encrypts everything with AES-GCM.
// * The DEK is stored only in "wrapped" (encrypted) form, twice:
//     - wrapped by a key derived from the passphrase      (PBKDF2-SHA256)
//     - wrapped by a key derived from the recovery code   (PBKDF2-SHA256)
//   Either secret unlocks the vault. Changing one never re-encrypts documents.
// * IndexedDB holds three stores:
//     meta  : 'keys' -> { cryptoVersion, wraps: { pass, recovery }, created }
//     items : { id, iv, ct }   ct = encrypted JSON metadata of one item
//     blobs : { id, iv, ct }   ct = encrypted bytes of one page image / original file
// * Schema changes go through onupgradeneeded with numbered, additive steps.
//   No step may delete user data.

export const DB_NAME = 'pocket-vault';
export const DB_VERSION = 1;
export const CRYPTO_VERSION = 1;
export const BACKUP_FORMAT = 'pocket-vault-backup';
export const BACKUP_FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 600000;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
const RECOVERY_LENGTH = 24;

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- small helpers ----------

export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export function newId() {
  return b64(rand(12)).replace(/\+/g, '-').replace(/\//g, '_');
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- database ----------

let dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const old = event.oldVersion;
      // Step 1: initial layout.
      if (old < 1) {
        db.createObjectStore('meta');
        db.createObjectStore('items', { keyPath: 'id' });
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
      // Future steps go here, e.g.
      // if (old < 2) { /* add an index; never delete stores */ }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If a newer version of the app opens the DB in another window, let it upgrade.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Pocket Vault windows, then reopen the app.'));
  });
}

function db() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

async function getOne(store, key) {
  const d = await db();
  return reqP(d.transaction(store, 'readonly').objectStore(store).get(key));
}

async function getAll(store) {
  const d = await db();
  return reqP(d.transaction(store, 'readonly').objectStore(store).getAll());
}

// fn(tx) must only issue IndexedDB requests synchronously (no awaits inside).
async function writeTx(stores, fn) {
  const d = await db();
  const t = d.transaction(stores, 'readwrite');
  fn(t);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was aborted (disk full?)'));
  });
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* not fatal */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (_) { /* ignore */ }
  return null;
}

// ---------- key handling ----------

async function deriveKEK(secret, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapRaw(rawDek, secret) {
  const salt = rand(16);
  const iv = rand(12);
  const kek = await deriveKEK(secret, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, rawDek);
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct), iterations: PBKDF2_ITERATIONS };
}

async function unwrapRaw(wrap, secret) {
  const kek = await deriveKEK(secret, unb64(wrap.salt), wrap.iterations);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrap.iv) }, kek, unb64(wrap.ct)));
}

export function normalisePassphrase(p) {
  return String(p).normalize('NFKC');
}

export function normaliseRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function looksLikeRecoveryCode(text) {
  const n = normaliseRecoveryCode(text);
  if (n.length !== RECOVERY_LENGTH) return false;
  for (const ch of n) if (!RECOVERY_ALPHABET.includes(ch)) return false;
  return true;
}

export function generateRecoveryCode() {
  const out = [];
  const n = RECOVERY_ALPHABET.length;
  const limit = 256 - (256 % n); // rejection sampling keeps every symbol equally likely
  while (out.length < RECOVERY_LENGTH) {
    for (const byte of rand(32)) {
      if (byte < limit && out.length < RECOVERY_LENGTH) out.push(RECOVERY_ALPHABET[byte % n]);
    }
  }
  return out.join('');
}

export function formatRecoveryCode(code) {
  return normaliseRecoveryCode(code).match(/.{1,4}/g).join('-');
}

// ---------- session state ----------

let rawKey = null;   // Uint8Array, only while unlocked (needed to re-wrap)
let dataKey = null;  // CryptoKey used for AES-GCM

async function setSessionKey(raw) {
  rawKey = raw;
  dataKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function isUnlocked() {
  return dataKey !== null;
}

export function lock() {
  if (rawKey) rawKey.fill(0);
  rawKey = null;
  dataKey = null;
}

export async function isSetUp() {
  return !!(await getOne('meta', 'keys'));
}

// Creates a new, empty vault. Returns the recovery code (show it once).
export async function setup(passphrase) {
  if (await isSetUp()) throw new Error('A vault already exists on this device.');
  const pass = normalisePassphrase(passphrase);
  if (pass.length < 8) throw new Error('Use at least 8 characters.');
  const raw = rand(32);
  const recovery = generateRecoveryCode();
  const keys = {
    cryptoVersion: CRYPTO_VERSION,
    created: new Date().toISOString(),
    wraps: {
      pass: await wrapRaw(raw, pass),
      recovery: await wrapRaw(raw, recovery),
    },
  };
  await writeTx(['meta'], (t) => t.objectStore('meta').put(keys, 'keys'));
  await setSessionKey(raw);
  return recovery;
}

// Accepts the passphrase or the recovery code. Returns 'pass' | 'recovery'.
export async function unlock(secret) {
  const keys = await getOne('meta', 'keys');
  if (!keys) throw new Error('No vault on this device yet.');
  const raw = await unlockWithKeys(keys, secret);
  await setSessionKey(raw.raw);
  return raw.via;
}

async function unlockWithKeys(keys, secret) {
  try {
    return { raw: await unwrapRaw(keys.wraps.pass, normalisePassphrase(secret)), via: 'pass' };
  } catch (_) { /* try the recovery code next */ }
  if (looksLikeRecoveryCode(secret)) {
    try {
      return { raw: await unwrapRaw(keys.wraps.recovery, normaliseRecoveryCode(secret)), via: 'recovery' };
    } catch (_) { /* fall through */ }
  }
  throw new Error('That passphrase or recovery code did not open the vault.');
}

function requireUnlocked() {
  if (!dataKey) throw new Error('The vault is locked.');
}

export async function changePassphrase(newPassphrase) {
  requireUnlocked();
  const pass = normalisePassphrase(newPassphrase);
  if (pass.length < 8) throw new Error('Use at least 8 characters.');
  const keys = await getOne('meta', 'keys');
  keys.wraps.pass = await wrapRaw(rawKey, pass);
  await writeTx(['meta'], (t) => t.objectStore('meta').put(keys, 'keys'));
}

// Replaces the recovery code. The old code stops working. Returns the new code.
export async function newRecoveryCode() {
  requireUnlocked();
  const code = generateRecoveryCode();
  const keys = await getOne('meta', 'keys');
  keys.wraps.recovery = await wrapRaw(rawKey, code);
  await writeTx(['meta'], (t) => t.objectStore('meta').put(keys, 'keys'));
  return code;
}

// ---------- encryption of content ----------

async function encryptBytes(bytes) {
  requireUnlocked();
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, bytes);
  return { iv, ct };
}

async function decryptBytes(iv, ct) {
  requireUnlocked();
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dataKey, ct);
}

// ---------- items ----------
//
// Item metadata (decrypted form):
// {
//   id, title, category, tags: [string], fields: [{label, value}], notes,
//   pinned: bool, created, updated,
//   pages:     [{ id, type, width, height }]   page images shown in the viewer
//   originals: [{ id, name, type, size }]      files as added (PDF etc.)
// }

export async function listItems() {
  requireUnlocked();
  const rows = await getAll('items');
  const out = [];
  for (const row of rows) {
    try {
      const plain = await decryptBytes(row.iv, row.ct);
      out.push(JSON.parse(td.decode(plain)));
    } catch (err) {
      console.error('Could not decrypt item', row.id, err);
    }
  }
  return out;
}

// newBlobs: [{ id, bytes: ArrayBuffer }] written in the same transaction as the item.
// removeBlobIds: blob ids no longer referenced by the item.
export async function saveItem(item, newBlobs = [], removeBlobIds = []) {
  requireUnlocked();
  const now = new Date().toISOString();
  const meta = { ...item, updated: now, created: item.created || now };
  const encMeta = await encryptBytes(te.encode(JSON.stringify(meta)));
  const encBlobs = [];
  for (const b of newBlobs) {
    const e = await encryptBytes(b.bytes);
    encBlobs.push({ id: b.id, iv: e.iv, ct: e.ct });
  }
  await writeTx(['items', 'blobs'], (t) => {
    t.objectStore('items').put({ id: meta.id, iv: encMeta.iv, ct: encMeta.ct });
    const bs = t.objectStore('blobs');
    for (const b of encBlobs) bs.put(b);
    for (const id of removeBlobIds) bs.delete(id);
  });
  return meta;
}

export async function deleteItem(item) {
  requireUnlocked();
  const ids = [...(item.pages || []), ...(item.originals || [])].map((p) => p.id);
  await writeTx(['items', 'blobs'], (t) => {
    t.objectStore('items').delete(item.id);
    const bs = t.objectStore('blobs');
    for (const id of ids) bs.delete(id);
  });
}

export async function getBlobBytes(id) {
  requireUnlocked();
  const row = await getOne('blobs', id);
  if (!row) throw new Error('Missing file data.');
  return decryptBytes(row.iv, row.ct);
}

// ---------- backup ----------
//
// The backup file holds the wrapped keys and the still-encrypted records.
// Nothing is decrypted to make it, and it opens only with the passphrase or
// recovery code that was current when it was made.

export async function exportBackup(appVersion) {
  const keys = await getOne('meta', 'keys');
  if (!keys) throw new Error('Nothing to back up yet.');
  const items = await getAll('items');
  const blobs = await getAll('blobs');
  const parts = [];
  const head = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    dbVersion: DB_VERSION,
    exported: new Date().toISOString(),
    itemCount: items.length,
    keys,
  };
  const headJson = JSON.stringify(head);
  parts.push(headJson.slice(0, -1) + ',"items":[');
  items.forEach((r, i) => parts.push((i ? ',' : '') + JSON.stringify({ id: r.id, iv: b64(r.iv), ct: b64(r.ct) })));
  parts.push('],"blobs":[');
  blobs.forEach((r, i) => parts.push((i ? ',' : '') + JSON.stringify({ id: r.id, iv: b64(r.iv), ct: b64(r.ct) })));
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

export async function readBackupFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    throw new Error('This file is not a Pocket Vault backup.');
  }
  if (!data || data.format !== BACKUP_FORMAT) throw new Error('This file is not a Pocket Vault backup.');
  if (data.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error('This backup was made by a newer version of Pocket Vault. Update the app first.');
  }
  if (!data.keys || !data.keys.wraps || !Array.isArray(data.items) || !Array.isArray(data.blobs)) {
    throw new Error('The backup file is incomplete or damaged.');
  }
  return data;
}

// Checks the secret against the backup's own keys before anything is replaced.
export async function checkBackupSecret(backup, secret) {
  await unlockWithKeys(backup.keys, secret);
  return true;
}

// Replaces everything on this device with the backup, then unlocks with the secret.
export async function restoreBackup(backup, secret) {
  const opened = await unlockWithKeys(backup.keys, secret);
  const items = backup.items.map((r) => ({ id: r.id, iv: unb64(r.iv), ct: unb64(r.ct) }));
  const blobs = backup.blobs.map((r) => ({ id: r.id, iv: unb64(r.iv), ct: unb64(r.ct) }));
  await writeTx(['meta', 'items', 'blobs'], (t) => {
    const m = t.objectStore('meta');
    const is = t.objectStore('items');
    const bs = t.objectStore('blobs');
    m.clear(); is.clear(); bs.clear();
    m.put(backup.keys, 'keys');
    for (const r of items) is.put(r);
    for (const r of blobs) bs.put(r);
  });
  await setSessionKey(opened.raw);
}
