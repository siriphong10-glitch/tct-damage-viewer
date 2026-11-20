/**
 * TCT Damage Viewer — ฐานข้อมูลบน Google Sheet + Google Drive
 * ---------------------------------------------------------------
 * - รายการความเสียหาย: Google Sheet แท็บ "tags" (1 แถว = 1 รายการ)
 * - กริด/จุด save: ไฟล์ JSON ในโฟลเดอร์ meta
 * - รูปถ่าย: โฟลเดอร์ photos/<รหัสรายการ>
 * - รหัสแก้ไข (EDIT_KEY) เก็บใน Script Properties เท่านั้น
 *
 * ติดตั้ง: ใส่ EDIT_KEY ใน Project Settings > Script Properties แล้วรัน setup() หนึ่งครั้ง
 * จากนั้น Deploy เป็น Web app (Execute as: Me, Who has access: Anyone)
 */

const ROOT_NAME = 'TCT Damage Viewer — ฐานข้อมูล';
const SHEET_NAME = 'tags';
const COLS = ['doc', 'id', 'surface', 'kind', 'type', 'severity', 'element', 'zone', 'gridText', 'locText',
  'description', 'note', 'area', 'reportArea', 'width', 'length', 'perimeter', 'repairStatus', 'date',
  'inspector', 'source', 'reportPage', 'approx', 'rangeBox', 'photoCount', 'tilt', 'createdAt', 'updatedAt',
  'updatedBy', 'serverUpdatedAt', 'position', 'points', 'camera', 'extra'];
const NUM = { severity: 1, area: 1, reportArea: 1, width: 1, length: 1, perimeter: 1, reportPage: 1, photoCount: 1, tilt: 1 };
const BOOL = { approx: 1, rangeBox: 1 };
const JSONC = { position: 1, points: 1, camera: 1, extra: 1 };
const CHUNK = 90000;

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k); }

// ---------- ติดตั้งครั้งแรก ----------
function setup() {
  const p = props_();
  if (!p.getProperty('EDIT_KEY')) throw new Error('ใส่ EDIT_KEY ใน Script Properties ก่อน');
  let root;
  if (p.getProperty('ROOT_ID')) root = DriveApp.getFolderById(p.getProperty('ROOT_ID'));
  else { root = DriveApp.createFolder(ROOT_NAME); p.setProperty('ROOT_ID', root.getId()); }
  if (!p.getProperty('META_ID')) p.setProperty('META_ID', root.createFolder('meta').getId());
  if (!p.getProperty('PHOTO_ID')) p.setProperty('PHOTO_ID', root.createFolder('photos').getId());
  if (!p.getProperty('BACKUP_ID')) p.setProperty('BACKUP_ID', root.createFolder('backup').getId());
  if (!p.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('TCT — รายการความเสียหาย (ฐานข้อมูล)');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    const sh = ss.getSheets()[0]; sh.setName(SHEET_NAME);
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold').setBackground('#f3f3f3');
    sh.getRange(1, 1, sh.getMaxRows(), COLS.length).setNumberFormat('@');
    sh.setFrozenRows(1); sh.setFrozenColumns(2);
    p.setProperty('SHEET_ID', ss.getId());
  }
  if (!p.getProperty('REV')) p.setProperty('REV', '1');
  return 'ok: ' + root.getUrl();
}

// ---------- HTTP ----------
function doGet(e) {
  const q = (e && e.parameter) || {};
  try {
    if (q.a === 'rev') return out_({ ok: true, rev: rev_(), metaRevs: metaRevs_() });
    if (q.a === 'all') return outText_(allJson_());
    if (q.a === 'metas') return out_({ ok: true, metas: readMetas_(String(q.names || '').split(',').filter(String)), metaRevs: metaRevs_() });
    if (q.a === 'photos') return out_({ ok: true, photos: readPhotos_(q.doc) });
    return out_({ ok: true, service: 'tct-damage-db', rev: rev_() });
  } catch (err) { return out_({ ok: false, error: String(err && err.message || err) }); }
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad-json' }); }
  if (!body || body.key !== prop_('EDIT_KEY')) return out_({ ok: false, error: 'denied' });
  if (body.a === 'check') return out_({ ok: true });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return out_({ ok: false, error: 'busy' });
  try {
    let res = {};
    if (body.a === 'saveTags') res = saveTags_(body.tags || [], body.by);
    else if (body.a === 'deleteTags') res = deleteTags_(body.docs || []);
    else if (body.a === 'setMeta') res = setMeta_(body.name, body.data, body.by);
    else if (body.a === 'setPhotos') res = setPhotos_(body.doc, body.photos || []);
    else if (body.a === 'setPhotosMany') { (body.items || []).forEach(function (it) { setPhotos_(it.doc, it.photos || []); }); res = { done: (body.items || []).length }; }
    else if (body.a === 'import') res = importAll_(body);
    else return out_({ ok: false, error: 'unknown-action' });
    return out_(Object.assign({ ok: true, rev: rev_() }, res));
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally { lock.releaseLock(); }
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function outText_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); }

// ---------- รุ่นข้อมูล + แคช ----------
// รุ่นข้อมูล = ตัวนับการเขียนผ่านเว็บ + เวลาแก้ไขล่าสุดของชีต (จับการแก้ในชีตโดยตรงได้ด้วย)
function rev_() {
  let lu = 0;
  try { lu = DriveApp.getFileById(prop_('SHEET_ID')).getLastUpdated().getTime(); } catch (e) {}
  return (prop_('REV') || '1') + '.' + lu;
}
function bump_() { props_().setProperty('REV', String(Number(prop_('REV') || 1) + 1)); return rev_(); }
function metaRevs_() { const s = prop_('META_REVS'); return s ? JSON.parse(s) : {}; }

function allJson_() {
  const r = rev_();
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('all_' + r + '_n') || 0);
  if (n) {
    const keys = []; for (let i = 0; i < n; i++) keys.push('all_' + r + '_' + i);
    const got = cache.getAll(keys);
    if (Object.keys(got).length === n) return keys.map(function (k) { return got[k]; }).join('');
  }
  const s = JSON.stringify({ ok: true, rev: r, metaRevs: metaRevs_(), tags: readTags_() });
  try {
    const parts = {}; let i = 0;
    for (let o = 0; o < s.length; o += CHUNK) parts['all_' + r + '_' + (i++)] = s.slice(o, o + CHUNK);
    parts['all_' + r + '_n'] = String(i);
    cache.putAll(parts, 21600);
  } catch (err) { /* แคชไม่ได้ก็ส่งตรง */ }
  return s;
}

// ---------- แท็บ tags ----------
function sheet_() { return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName(SHEET_NAME); }

function header_(sh) {
  const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  // เพิ่มคอลัมน์ที่ขาด (เผื่อมีคนลบ/สลับคอลัมน์)
  const miss = COLS.filter(function (c) { return h.indexOf(c) < 0; });
  if (miss.length) { sh.getRange(1, h.length + 1, 1, miss.length).setValues([miss]); return h.concat(miss); }
  return h;
}

function rowToTag_(h, row) {
  const t = {}; let extra = null;
  for (let i = 0; i < h.length; i++) {
    const k = h[i]; let v = row[i];
    if (!k || v === '' || v === null) continue;
    v = String(v);
    if (k === 'doc') { t._doc = v; continue; }
    if (JSONC[k]) { try { v = JSON.parse(v); } catch (e) { continue; } if (k === 'extra') { extra = v; continue; } }
    else if (NUM[k]) { const n = Number(v); if (!isFinite(n)) continue; v = n; }
    else if (BOOL[k]) v = /^(true|1|yes|ใช่)$/i.test(v);
    t[k] = v;
  }
  if (extra && typeof extra === 'object') for (const k in extra) if (!(k in t)) t[k] = extra[k];
  return t;
}

function tagToRow_(h, t) {
  const extra = {};
  for (const k in t) if (k !== '_doc' && k.charAt(0) !== '_' && k !== 'photos' && COLS.indexOf(k) < 0 && t[k] !== undefined) extra[k] = t[k];
  return h.map(function (k) {
    if (k === 'doc') return t._doc || '';
    if (k === 'extra') return Object.keys(extra).length ? JSON.stringify(extra) : '';
    const v = t[k];
    if (v === undefined || v === null) return '';
    if (JSONC[k] || typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

function readTags_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const h = header_(sh);
  const vals = sh.getRange(2, 1, last - 1, h.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) { const t = rowToTag_(h, vals[i]); if (t._doc && t.id) out.push(t); }
  return out;
}

function saveTags_(tags, by) {
  const sh = sheet_();
  const h = header_(sh);
  const last = sh.getLastRow();
  const docs = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const idx = {}; docs.forEach(function (d, i) { if (d) idx[d] = i + 2; });
  const now = new Date().toISOString();
  const append = [];
  tags.forEach(function (t) {
    if (!t || !t._doc) return;
    t.serverUpdatedAt = now;
    if (by && !t.updatedBy) t.updatedBy = by;
    const row = tagToRow_(h, t);
    if (idx[t._doc]) sh.getRange(idx[t._doc], 1, 1, h.length).setValues([row]);
    else append.push(row);
  });
  if (append.length) {
    const r0 = sh.getLastRow() + 1;
    const rng = sh.getRange(r0, 1, append.length, h.length);
    rng.setNumberFormat('@'); rng.setValues(append);
  }
  return { saved: tags.length, rev: bump_() };
}

function deleteTags_(docList) {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2 || !docList.length) return { deleted: 0, rev: rev_() };
  const want = {}; docList.forEach(function (d) { want[String(d)] = 1; });
  const docs = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
  const rows = []; docs.forEach(function (d, i) { if (want[d]) rows.push(i + 2); });
  // ลบจากล่างขึ้นบน รวมแถวที่ติดกันเป็นช่วงเดียว
  rows.sort(function (a, b) { return b - a; });
  let i = 0;
  while (i < rows.length) {
    let j = i; while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], j - i + 1);
    i = j + 1;
  }
  const pf = DriveApp.getFolderById(prop_('PHOTO_ID'));
  docList.forEach(function (d) { const it = pf.getFoldersByName(String(d)); while (it.hasNext()) it.next().setTrashed(true); });
  return { deleted: rows.length, rev: bump_() };
}

// ---------- meta (กริด / จุด save) ----------
function metaFolder_() { return DriveApp.getFolderById(prop_('META_ID')); }
function metaFile_(name) { const it = metaFolder_().getFilesByName(name + '.json'); return it.hasNext() ? it.next() : null; }

function readMetas_(names) {
  const o = {};
  names.forEach(function (n) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) return;
    const f = metaFile_(n);
    o[n] = f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : null;
  });
  return o;
}

function setMeta_(name, data, by) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(name))) throw new Error('bad-meta-name');
  const now = new Date().toISOString();
  const d = Object.assign({}, data || {}, { updatedBy: by || 'ผู้แก้ไขผ่านลิงก์', serverUpdatedAt: now });
  const s = JSON.stringify(d);
  const f = metaFile_(name);
  if (f) f.setContent(s); else metaFolder_().createFile(name + '.json', s, 'application/json');
  const mr = metaRevs_(); mr[name] = now; props_().setProperty('META_REVS', JSON.stringify(mr));
  return { metaRev: now };
}

// ---------- รูปถ่าย ----------
function setPhotos_(doc, photos) {
  const pf = DriveApp.getFolderById(prop_('PHOTO_ID'));
  const it = pf.getFoldersByName(String(doc));
  let f = it.hasNext() ? it.next() : pf.createFolder(String(doc));
  const old = f.getFiles(); while (old.hasNext()) old.next().setTrashed(true);
  photos.forEach(function (p, i) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(p || '');
    if (!m) return;
    const ext = m[1].indexOf('png') >= 0 ? 'png' : 'jpg';
    f.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'p' + ('00' + i).slice(-3) + '.' + ext));
  });
  return { photos: photos.length };
}

function readPhotos_(doc) {
  const pf = DriveApp.getFolderById(prop_('PHOTO_ID'));
  const it = pf.getFoldersByName(String(doc));
  if (!it.hasNext()) return [];
  const files = []; const fi = it.next().getFiles();
  while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  return files.map(function (f) { const b = f.getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); });
}

// ---------- ย้ายข้อมูลทั้งชุด ----------
function importAll_(body) {
  const bf = DriveApp.getFolderById(prop_('BACKUP_ID'));
  if (body.backup) bf.createFile('import-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', JSON.stringify(body.backup), 'application/json');
  let res = {};
  if (body.tags && body.tags.length) res = saveTags_(body.tags, body.by);
  const metas = body.metas || {};
  Object.keys(metas).forEach(function (k) { if (metas[k] && typeof metas[k] === 'object') setMeta_(k, metas[k], metas[k].updatedBy); });
  return res;
}
