// Pocket Vault — picking key details out of text read from a document.
// Pure functions: no network, no storage. Tuned for Indian bank passbooks
// and cheques, PAN, Aadhaar and passports (including the machine-readable
// zone), and tolerant of typical OCR confusions (O/0, I/1, S/5, B/8).

// ---------- helpers ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad2 = (n) => String(n).padStart(2, '0');

// Make a digit run out of OCR text that should be numeric.
export function toDigits(s) {
  return String(s)
    .replace(/[Oo]/g, '0').replace(/[Il|!]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2')
    .replace(/\D/g, '');
}

function cleanText(s) {
  return String(s).replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:;.,\-–—]+|[\s:;.,\-–—]+$/g, '').trim();
}

function titleCase(s) {
  return cleanText(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

// Recognises 12/05/1961, 12-05-61, 12.05.1961, 12 May 1961, 12-MAY-1961.
function parseDateToken(tok) {
  let m = tok.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y > 40 ? 1900 : 2000;
    const d = +m[1], mo = +m[2];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${pad2(d)}/${pad2(mo)}/${y}`;
  }
  m = tok.match(/\b(\d{1,2})[\s\-\/.]*([A-Za-z]{3,9})[\s\-\/.,]*(\d{4})\b/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase() === 'sept' ? 4 : 3)];
    if (mo && +m[1] >= 1 && +m[1] <= 31) return `${pad2(+m[1])}/${pad2(mo)}/${m[3]}`;
  }
  return null;
}

function findDates(line) {
  const out = [];
  const re = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b|\b\d{1,2}[\s\-\/.]*[A-Za-z]{3,9}[\s\-\/.,]*\d{4}\b/g;
  for (const m of line.matchAll(re)) {
    const d = parseDateToken(m[0]);
    if (d) out.push(d);
  }
  return out;
}

// ---------- Verhoeff (Aadhaar check digit) ----------

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(num) {
  let c = 0;
  const digits = String(num).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = VD[c][VP[i % 8][digits[i]]];
  return c === 0;
}

// ---------- passport machine-readable zone (TD3) ----------

function mrzValue(ch) {
  if (ch === '<') return 0;
  if (/[0-9]/.test(ch)) return +ch;
  return ch.charCodeAt(0) - 55; // A=10
}

function mrzCheck(field, digit) {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += mrzValue(field[i]) * w[i % 3];
  return String(sum % 10) === digit;
}

function mrzDate(yymmdd, future) {
  const yy = +yymmdd.slice(0, 2), mm = yymmdd.slice(2, 4), dd = yymmdd.slice(4, 6);
  const now = new Date().getFullYear() % 100;
  const century = future ? 2000 : (yy > now ? 1900 : 2000);
  return `${dd}/${mm}/${century + yy}`;
}

function parseMrz(lines) {
  const cand = lines
    .map((l) => l.replace(/\s+/g, '').replace(/[«‹(\[{]/g, '<').replace(/[»›)\]}]/g, '<').toUpperCase())
    .map((l) => l.replace(/[^A-Z0-9<]/g, ''));
  for (let i = 0; i < cand.length - 1; i++) {
    const l1 = cand[i];
    const l2 = cand[i + 1];
    if (!/^P[A-Z<][A-Z<]{3}/.test(l1) || l1.length < 30 || l2.length < 28) continue;
    if ((l1.match(/</g) || []).length < 3) continue;
    // Numeric positions in line 2 may be misread as letters.
    const fixNum = (s) => s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
    const docNo = l2.slice(0, 9);
    const docChk = fixNum(l2[9] || '');
    const nat = l2.slice(10, 13).replace(/0/g, 'O');
    const dob = fixNum(l2.slice(13, 19));
    const dobChk = fixNum(l2[19] || '');
    const sex = (l2[20] || '').replace('<', '');
    const exp = fixNum(l2.slice(21, 27));
    const expChk = fixNum(l2[27] || '');
    if (!/^\d{6}$/.test(dob) || !/^\d{6}$/.test(exp)) continue;
    // Indian passport numbers: one letter then seven digits.
    let num = docNo.replace(/</g, '');
    if (/^[A-Z0-9]\w{7}$/.test(num)) num = num[0].replace(/0/, 'O').replace(/1/, 'I').replace(/5/, 'S').replace(/8/, 'B') + fixNum(num.slice(1));
    const checks = [mrzCheck(num.padEnd(9, '<'), docChk), mrzCheck(dob, dobChk), mrzCheck(exp, expChk)];
    const nameField = l1.slice(5).replace(/<+$/, '');
    const [surname, given] = nameField.split('<<');
    return {
      verified: checks.every(Boolean),
      passportNumber: num,
      nationality: nat,
      dob: mrzDate(dob, false),
      expiry: mrzDate(exp, true),
      sex: sex === 'M' ? 'Male' : sex === 'F' ? 'Female' : '',
      surname: surname ? titleCase(surname.replace(/</g, ' ')) : '',
      given: given ? titleCase(given.replace(/</g, ' ')) : '',
    };
  }
  return null;
}

// ---------- banks ----------

const BANKS = {
  SBIN: ['SBI', 'State Bank of India'], HDFC: ['HDFC Bank', 'HDFC Bank'], ICIC: ['ICICI Bank', 'ICICI Bank'],
  UTIB: ['Axis Bank', 'Axis Bank'], CNRB: ['Canara Bank', 'Canara Bank'], BARB: ['Bank of Baroda', 'Bank of Baroda'],
  UBIN: ['Union Bank', 'Union Bank of India'], PUNB: ['PNB', 'Punjab National Bank'], KKBK: ['Kotak', 'Kotak Mahindra Bank'],
  INDB: ['IndusInd', 'IndusInd Bank'], YESB: ['Yes Bank', 'Yes Bank'], IDFB: ['IDFC First', 'IDFC First Bank'],
  FDRL: ['Federal Bank', 'Federal Bank'], IDIB: ['Indian Bank', 'Indian Bank'], BKID: ['Bank of India', 'Bank of India'],
  CBIN: ['Central Bank', 'Central Bank of India'], IOBA: ['IOB', 'Indian Overseas Bank'], UCBA: ['UCO Bank', 'UCO Bank'],
  MAHB: ['Bank of Maharashtra', 'Bank of Maharashtra'], PSIB: ['Punjab & Sind Bank', 'Punjab & Sind Bank'],
  KARB: ['Karnataka Bank', 'Karnataka Bank'], KVBL: ['Karur Vysya', 'Karur Vysya Bank'], CIUB: ['City Union', 'City Union Bank'],
  SIBL: ['South Indian Bank', 'South Indian Bank'], TMBL: ['TMB', 'Tamilnad Mercantile Bank'], DBSS: ['DBS', 'DBS Bank India'],
  AUBL: ['AU Bank', 'AU Small Finance Bank'], RATN: ['RBL Bank', 'RBL Bank'], CSBK: ['CSB Bank', 'CSB Bank'],
  DLXB: ['Dhanlaxmi', 'Dhanlaxmi Bank'], JAKA: ['J&K Bank', 'Jammu and Kashmir Bank'], ESFB: ['Equitas', 'Equitas Small Finance Bank'],
};

const BANK_NAMES = Object.values(BANKS).map(([short, long]) => ({ short, long, re: new RegExp('\\b' + long.replace(/[&]/g, '(&|and)').replace(/\s+/g, '\\s*') + '\\b', 'i') }));

function findIfsc(text) {
  const tokens = text.toUpperCase().match(/[A-Z0-9]{11}/g) || [];
  for (const t of tokens) {
    const head = t.slice(0, 4).replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
    const fifth = t[4].replace(/[ODQ]/, '0');
    let tail = t.slice(5);
    const tailNum = tail.replace(/[ODQ]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
    if (/^\d{6}$/.test(tailNum)) tail = tailNum;
    const cand = head + fifth + tail;
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cand)) {
      if (BANKS[head] || /IFSC/i.test(text)) return cand;
    }
  }
  return null;
}

// ---------- labelled values ----------

function labelled(lines, labelRe, valueRe) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(labelRe);
    if (!m) continue;
    const after = l.slice(m.index + m[0].length);
    const v = after.match(valueRe);
    if (v) return v[1] !== undefined ? v[1] : v[0];
    // Value on the next line (common on cards and passbook headers).
    if (lines[i + 1]) {
      const v2 = lines[i + 1].match(valueRe);
      if (v2) return v2[1] !== undefined ? v2[1] : v2[0];
    }
  }
  return null;
}

// ---------- address ----------

const STATES = /(andhra|arunachal|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal|jharkhand|karnataka|kerala|madhya|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|orissa|punjab|rajasthan|sikkim|tamil|telangana|tripura|uttar|uttarakhand|bengal|delhi|chandigarh|puducherry|pondicherry|jammu|kashmir|ladakh|lakshadweep|andaman|dadra|daman)/i;

function isBank0(upper) {
  return /IFSC|PASSBOOK|A\/C|ACCOUNT/.test(upper);
}

// Address: the text after an "Address" label up to and including the line with
// the 6-digit PIN code; or, without a label, the 1–3 lines ending at a line that
// has a PIN code and a state name. Lines in other scripts that OCR turned into
// noise are skipped.
// Two to four capitalised words, as names are printed on Indian ID documents.
const NAME_RE = /^[A-Z][A-Za-z.']+(?: [A-Z][A-Za-z.']*){1,3}$/;
const NOT_NAME = /GOVERNMENT|INDIA|INCOME|DEPARTMENT|FATHER|AUTHORITY|ENROL|AADHAAR|ADDRESS|MALE|BIRTH|BANK|BRANCH/i;

// Holder's name on an Aadhaar card or letter: the line above "S/O …" or
// "C/O …", or an English name line printed more than once.
function findAadhaarName(lines) {
  const strip = (l) => l.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z.]+$/, '').replace(/\s+/g, ' ').trim();
  const ok = (l) => NAME_RE.test(l) && !NOT_NAME.test(l);
  for (let i = 1; i < lines.length; i++) {
    if (/^\W*[CSDW]\s?\/\s?O\b/i.test(lines[i])) {
      const prev = strip(lines[i - 1]);
      if (ok(prev)) return prev;
    }
  }
  const seen = new Map();
  for (const l of lines) {
    const s = strip(l);
    if (!ok(s)) continue;
    const k = s.toLowerCase();
    seen.set(k, (seen.get(k) || { s, n: 0 }));
    seen.get(k).n++;
  }
  for (const { s, n } of seen.values()) if (n >= 2) return s;
  return null;
}

function findAddress(lines) {
  const pinRe = /(?<![0-9])([1-9][0-9]{2}\s?[0-9]{3})(?![0-9])/;
  const looksText = (l) => (l.match(/[A-Za-z]/g) || []).length >= Math.max(4, l.replace(/\s/g, '').length * 0.55);
  const clean = (l) => l.replace(/^\s*address\s*[:\-]?\s*/i, '').replace(/[|_~]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,.:;\-]+|[\s,;\-]+$/g, '').trim();
  const skip = (l) => /\b(dob|date of birth|male|female|vid|aadhaar|government of india|unique identification|enrol\w*|mobile|help@|1947|www\.)\b/i.test(l);
  const pinEnd = (from, max) => {
    for (let i = from; i < Math.min(lines.length, from + max); i++) if (pinRe.test(lines[i])) return i;
    return -1;
  };
  let name = null;
  let marked = true;
  let start = lines.findIndex((l) => /\baddress\b\s*[:\-]?/i.test(l) && !/e-?mail|web|www/i.test(l));
  let end = -1;
  if (start >= 0) {
    end = pinEnd(start, 8);
    if (end < 0) end = Math.min(lines.length - 1, start + 3);
  } else {
    // Aadhaar letter: "To" (or "To, Name") followed by name and address down to the PIN code.
    const toIdx = lines.findIndex((l) => /^\s*to\b[\s,:.]*([A-Za-z][A-Za-z .']{2,40})?\s*$/i.test(l));
    if (toIdx >= 0) {
      const same = lines[toIdx].replace(/^\s*to\b[\s,:.]*/i, '').trim();
      let i = toIdx + 1;
      if (same) name = same;
      else {
        while (i < lines.length && !looksText(clean(lines[i]))) i++;
        const cand = i < lines.length ? clean(lines[i]).replace(/^[^A-Za-z]+/, '') : '';
        if (NAME_RE.test(cand) && !/^[CSDW]\s?\/\s?O\b/i.test(cand)) { name = cand; i++; }
      }
      const e = pinEnd(i, 9);
      if (e >= 0) { start = i; end = e; }
    }
    if (end < 0) {
      marked = false;
      end = lines.findIndex((l) => pinRe.test(l) && STATES.test(l));
      if (end < 0) return null;
      start = end;
      // Walk back over address-like lines (at most 6).
      while (start > 0 && end - start < 5) {
        const l = clean(lines[start - 1]);
        if (!looksText(l) || skip(l)) break;
        start--;
      }
    }
  }
  const parts = [];
  for (let i = start; i <= end; i++) {
    const l = clean(lines[i]);
    // Inside a marked block ("Address:" or "To") short lines such as "#E-09" are kept.
    if (!l || (!(marked && /[A-Za-z0-9]/.test(l)) && !looksText(l) && !pinRe.test(l))) continue;
    if (skip(l)) continue;
    parts.push(l);
  }
  // A bare name directly above "S/O …" / "C/O …" is the holder's name, not address.
  if (!name && parts.length > 2 && /^[A-Za-z][A-Za-z.']*( [A-Za-z][A-Za-z.']*){1,3}$/.test(parts[0]) && /^[CSDW]\s?\/\s?O\b/i.test(parts[1])) name = parts.shift();
  if (!parts.length) return null;
  const text = parts.join(', ').replace(/,\s*,/g, ',').replace(/\s+,/g, ',');
  const pm = text.match(pinRe);
  return { text, pin: pm ? pm[1].replace(/\s/g, '') : null, name };
}

// ---------- main ----------

// -> { kind, title, category, tags, fields:[{label,value,sure}], summary }
export function extractDetails(rawText) {
  const text = String(rawText || '').replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const upper = text.toUpperCase();
  const fields = [];
  const add = (label, value, sure = true) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v || fields.some((f) => f.label === label)) return;
    fields.push({ label, value: v, sure });
  };

  // ----- Passport -----
  const mrz = parseMrz(lines);
  const isPassport = !!mrz || /\bPASSPORT\b/.test(upper) || /REPUBLIC OF INDIA/.test(upper);
  if (mrz) {
    add('Passport number', mrz.passportNumber, mrz.verified);
    if (mrz.surname || mrz.given) add('Name as printed', [mrz.given, mrz.surname].filter(Boolean).join(' '), mrz.verified);
    add('Date of birth', mrz.dob, mrz.verified);
    add('Date of expiry', mrz.expiry, mrz.verified);
    if (mrz.sex) add('Sex', mrz.sex, mrz.verified);
    add('Nationality', mrz.nationality === 'IND' ? 'Indian' : mrz.nationality, mrz.verified);
  } else if (isPassport) {
    const pno = (upper.match(/\b([A-Z])\s?([0-9OIl]{7})\b/) || []);
    if (pno[0]) add('Passport number', pno[1] + toDigits(pno[2]), false);
  }
  if (isPassport) {
    const issue = labelled(lines, /date\s+of\s+issue/i, /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/);
    if (issue) add('Date of issue', parseDateToken(issue));
    const place = labelled(lines, /place\s+of\s+issue/i, /([A-Za-z][A-Za-z .]{2,30})/);
    if (place) add('Place of issue', titleCase(place), false);
  }

  // ----- PAN -----
  let pan = null;
  for (const m of upper.matchAll(/\b([A-Z]{5})\s?([0-9OISB]{4})\s?([A-Z])\b/g)) {
    const c = m[1] + toDigits(m[2]).padEnd(4, '?') + m[3];
    if (/^[A-Z]{3}[PCHABGJLFT][A-Z][0-9]{4}[A-Z]$/.test(c)) { pan = c; break; }
  }
  const isPan = !!pan && (/INCOME\s*TAX|PERMANENT\s*ACCOUNT/.test(upper) || !isPassport);
  if (pan) add('PAN', pan);

  // ----- Aadhaar -----
  let aadhaar = null;
  for (const m of text.matchAll(/(?<![0-9])([0-9OIl]{4})[ \-]?([0-9OIl]{4})[ \-]?([0-9OIl]{4})(?![0-9])/g)) {
    const d = toDigits(m[0]);
    if (d.length !== 12 || /^[01]/.test(d)) continue;
    const lineOf = lines.find((l) => l.includes(m[0])) || '';
    if (/\bVID\b/i.test(lineOf)) continue;
    if (verhoeffValid(d)) { aadhaar = `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8)}`; break; }
  }
  const isAadhaar = !!aadhaar && (/AADHAAR|UNIQUE IDENTIFICATION|GOVERNMENT OF INDIA|\bUIDAI\b|ENROL/.test(upper) || (!isPan && !isPassport));
  if (aadhaar) add('Aadhaar number', aadhaar);

  // Identity-card style name / DOB / gender
  const dobLineIdx = lines.findIndex((l) => /\b(DOB|D\.O\.B|date\s+of\s+birth|year\s+of\s+birth)\b/i.test(l));
  if (dobLineIdx >= 0 && !fields.some((f) => f.label === 'Date of birth')) {
    const ds = findDates(lines[dobLineIdx]).concat(lines[dobLineIdx + 1] ? findDates(lines[dobLineIdx + 1]) : []);
    if (ds[0]) add('Date of birth', ds[0]);
    else {
      const y = lines[dobLineIdx].match(/\b(19|20)\d{2}\b/);
      if (y) add('Year of birth', y[0]);
    }
  }
  if ((isAadhaar || isPan) && !fields.some((f) => /^Name/.test(f.label))) {
    let nm = labelled(lines, /^\s*name\b\s*[:\-\/]?/i, /([A-Za-z][A-Za-z .']{2,40})/);
    if (!nm && dobLineIdx > 0) {
      const prev = lines[dobLineIdx - 1];
      if (/^[A-Za-z][A-Za-z .']{3,40}$/.test(prev) && !/GOVERNMENT|INDIA|INCOME|DEPARTMENT|FATHER/i.test(prev)) nm = prev;
    }
    if (!nm && isAadhaar) nm = findAadhaarName(lines);
    if (nm) add('Name as printed', titleCase(nm), false);
  }
  if (isAadhaar) {
    const g = upper.match(/\b(MALE|FEMALE|TRANSGENDER)\b/);
    if (g) add('Gender', titleCase(g[1]));
  }
  if (isAadhaar || isBank0(upper)) {
    const addr = findAddress(lines);
    if (addr) {
      if (addr.name && !fields.some((f) => /^Name/.test(f.label))) add('Name as printed', titleCase(addr.name), false);
      add('Address', addr.text, false);
      if (addr.pin) add('PIN code', addr.pin, false);
    }
  }

  // ----- Bank -----
  const ifsc = findIfsc(text);
  let bank = ifsc ? BANKS[ifsc.slice(0, 4)] : null;
  if (!bank) {
    const named = BANK_NAMES.find((b) => b.re.test(text));
    if (named) bank = [named.short, named.long];
  }
  const isBank = !!ifsc || (!!bank && /(A\/C|ACCOUNT|PASSBOOK|BRANCH|CIF|CUSTOMER)/.test(upper));
  if (isBank) {
    if (bank) add('Bank', bank[1]);
    // "A/c No." is often misread ("Jc No.", "/c No", "AIC No"), so accept any short prefix before "c No".
    const acct = labelled(lines, /(?:account|acct|\b[a-z]{0,2}\s*[\/|\\]?\s*c)\s*\.?\s*(?:no|number|num)\b\s*\.?\s*[:\-#]?/i, /([0-9OIl][0-9OIl \-]{7,22}[0-9OIl])/);
    let acctDigits = acct ? toDigits(acct) : '';
    if (!(acctDigits.length >= 9 && acctDigits.length <= 18)) {
      // Fall back to the longest plausible digit run that is not something else.
      // Fall back to the longest digit run on a line that is clearly not something else.
      const runs = [];
      for (const l of lines) {
        if (/(cif|customer\s*id|cust|micr|branch\s*code|mobile|phone|tel|pin|ifsc)/i.test(l)) continue;
        for (const r of l.match(/(?<![0-9])[0-9]{11,18}(?![0-9])/g) || []) runs.push(r);
      }
      acctDigits = runs.sort((a, b) => b.length - a.length)[0] || '';
      if (acctDigits) add('Account number', acctDigits, false);
    } else {
      add('Account number', acctDigits);
    }
    if (ifsc) add('IFSC', ifsc);
    const cif = labelled(lines, /(cif|customer\s*(id|no|number)|cust\.?\s*id)\s*(no|number)?\s*\.?\s*[:\-#]?/i, /([0-9OIl][0-9OIl ]{5,16}[0-9OIl])/);
    if (cif && toDigits(cif) !== acctDigits) add('Customer ID (CIF)', toDigits(cif));
    const micr = labelled(lines, /micr\s*(code|no)?\s*\.?\s*[:\-]?/i, /([0-9OIl]{9})/);
    if (micr) add('MICR', toDigits(micr));
    const branch = labelled(lines, /\b[bg]?ranch\b(?!\s*code)\s*(name)?\s*[:\-]?/i, /([A-Za-z][A-Za-z0-9 ,.&()\-']{2,60})/);
    if (branch) add('Branch', titleCase(branch.replace(/\b\w?ranch\s*code.*$/i, '').replace(/\b(ifsc|micr).*$/i, '')), false);
    const bcode = labelled(lines, /branch\s*code\s*[:\-]?/i, /([0-9OIl]{3,6})/);
    if (bcode) add('Branch code', toDigits(bcode), false);
    let holder = labelled(lines, /(account\s*holder|a\/c\s*holder|customer\s*name|name\s*of\s*(the\s*)?customer|^\s*name)\s*(\(s\))?\s*[:\-]/i, /([A-Za-z][A-Za-z .']{2,50})/);
    if (!holder) {
      const l = lines.find((x) => /\bname\s*[:\-]/i.test(x) && !/(branch|bank|father|nominee|mother|spouse)\s*name/i.test(x));
      if (l) { const m = l.slice(l.search(/\bname\s*[:\-]/i)).match(/name\s*[:\-]\s*([A-Za-z][A-Za-z .']{2,50})/i); if (m) holder = m[1]; }
    }
    if (holder && !/branch|bank/i.test(holder)) add('Account holder', titleCase(holder.replace(/^\s*(mr|mrs|ms|miss|shri|smt|sri|dr)\.?\s+/i, '')), false);
    const type = /\bCURRENT\s+(A\/?C|ACCOUNT)\b/.test(upper) ? 'Current' : /\b(SAVINGS?|SB\s*A\/?C|S\.B\.)\b/.test(upper) ? 'Savings' : null;
    if (type) add('Account type', type, false);
    const opened = labelled(lines, /(date\s*of\s*opening|opening\s*date|a\/c\s*open(ing)?\s*date)/i, /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s*[A-Za-z]{3,9}\s*\d{4})/);
    if (opened) add('Date of opening', parseDateToken(opened), false);
    const nominee = labelled(lines, /nominee\s*(name)?\s*[:\-]/i, /([A-Za-z][A-Za-z .']{2,40})/);
    if (nominee) add('Nominee', titleCase(nominee), false);
  }

  // ----- Generic expiry (licences, insurance, cards) -----
  if (!fields.some((f) => /expiry/i.test(f.label))) {
    const exp = labelled(lines, /(date\s*of\s*expiry|valid\s*(till|upto|up\s*to|until|thru)|expiry\s*date|expires)/i, /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s*[A-Za-z]{3,9}\s*\d{4}|\d{2}\/\d{2})/);
    if (exp) add('Date of expiry', parseDateToken(exp) || exp, false);
  }

  // ----- What is it? -----
  let kind = 'other';
  if (isPassport && (mrz || fields.some((f) => f.label === 'Passport number'))) kind = 'passport';
  else if (isBank) kind = 'bank';
  else if (isPan) kind = 'pan';
  else if (isAadhaar) kind = 'aadhaar';

  const meta = {
    passport: { title: 'Passport', category: 'travel', tags: ['passport', 'travel', 'ID'] },
    pan: { title: 'PAN card', category: 'identity', tags: ['pan', 'tax', 'ID'] },
    aadhaar: { title: 'Aadhaar card', category: 'identity', tags: ['aadhaar', 'uid', 'ID'] },
    bank: {
      title: `${bank ? bank[0] + ' ' : ''}${(fields.find((f) => f.label === 'Account type') || {}).value === 'Current' ? 'current' : 'savings'} account`.replace(/^./, (c) => c.toUpperCase()),
      category: 'bank',
      tags: ['bank', 'account', 'passbook'].concat(bank ? [bank[0].toLowerCase()] : []).concat(ifsc ? ['ifsc'] : []),
    },
    other: { title: '', category: '', tags: [] },
  }[kind];

  // Order fields sensibly for display.
  const order = ['Name as printed', 'Account holder', 'Address', 'PIN code', 'Passport number', 'PAN', 'Aadhaar number', 'Bank', 'Account number', 'Account type', 'IFSC', 'MICR', 'Branch', 'Branch code', 'Customer ID (CIF)', 'Date of birth', 'Year of birth', 'Gender', 'Sex', 'Nationality', 'Date of issue', 'Place of issue', 'Date of expiry', 'Date of opening', 'Nominee'];
  fields.sort((a, b) => (order.indexOf(a.label) + 100) % 100 - (order.indexOf(b.label) + 100) % 100);

  return { kind, title: meta.title, category: meta.category, tags: meta.tags, fields };
}
