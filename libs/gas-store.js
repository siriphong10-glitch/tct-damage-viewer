// ที่เก็บข้อมูลบน Google Sheet/Drive ผ่าน Google Apps Script (แทน Firebase)
// อินเทอร์เฟซเดียวกับ store เดิม: subscribe / saveTag / deleteTag / loadPhotos / subscribeMeta / setMeta
// เพิ่ม saveTags / deleteTags สำหรับงานทีละมาก ๆ
export function createGasStore(cfg) {
  const url = cfg.gasUrl;
  const key = cfg.editKey || "";
  const POLL_MS = cfg.pollMs || 30000;
  let rev = -1, metaRevs = {}, tags = new Map();
  const pending = new Map(); // _doc -> tag | null (ลบ)
  const subs = [], authCbs = [], metaSubs = {};
  let auth = { user: null, email: "", isOwner: false, isEditor: false, viaLink: false, editors: [] };

  const rand = () => { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const b = crypto.getRandomValues(new Uint8Array(20)); for (const x of b) s += a[x % 62]; return s; };
  const fail = (msg) => Object.assign(new Error(msg), { code: msg === "denied" ? "permission-denied" : msg });

  async function get(params) {
    const r = await fetch(url + "?" + new URLSearchParams({ ...params, _: Date.now() }), { redirect: "follow" });
    if (!r.ok) throw fail("http-" + r.status);
    const j = await r.json();
    if (!j.ok) throw fail(j.error || "error");
    return j;
  }
  async function post(body, tries = 3) {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...body, key }), redirect: "follow" });
        if (!r.ok) throw fail("http-" + r.status);
        const j = await r.json();
        if (!j.ok) throw fail(j.error || "error");
        return j;
      } catch (e) {
        if (e.code === "permission-denied" || i >= tries - 1) throw e;
        await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      }
    }
  }

  const list = () => {
    const m = new Map(tags);
    for (const [d, t] of pending) { if (t) m.set(d, t); else m.delete(d); }
    return [...m.entries()].map(([d, t]) => ({ ...t, _doc: d }));
  };
  const emit = () => { const l = list(); const meta = { pending: pending.size > 0, fromCache: false }; subs.forEach((s) => s.cb(l, meta)); };

  async function loadAll() {
    const j = await get({ a: "all" });
    rev = j.rev; tags = new Map(j.tags.map((t) => [t._doc, t]));
    checkMetaRevs(j.metaRevs || {});
    emit();
  }
  let polling = false;
  async function poll(force) {
    if (polling) return; polling = true;
    try {
      const j = await get({ a: "rev" });
      if (force || j.rev !== rev) await loadAll(); else checkMetaRevs(j.metaRevs || {});
    } catch (e) { subs.forEach((s) => s.onError && s.onError(e)); }
    finally { polling = false; }
  }
  let metaQueue = new Set(), metaTimer = 0;
  function fetchMetas(names) {
    names.forEach((n) => metaQueue.add(n));
    if (metaTimer) return;
    metaTimer = setTimeout(async () => {
      metaTimer = 0; const ns = [...metaQueue]; metaQueue = new Set();
      try {
        const j = await get({ a: "metas", names: ns.join(",") });
        for (const n of ns) (metaSubs[n] || []).forEach((cb) => cb(j.metas[n] || null));
        Object.assign(metaRevs, Object.fromEntries(ns.map((n) => [n, (j.metaRevs || {})[n] || null])));
      } catch (e) { console.error(e); }
    }, 30);
  }
  function checkMetaRevs(mr) {
    const changed = Object.keys(metaSubs).filter((n) => (mr[n] || null) !== (metaRevs[n] || null) && n in metaRevs);
    if (changed.length) fetchMetas(changed);
  }

  // ตรวจรหัสแก้ไขจากลิงก์
  (async () => {
    if (!key) { authCbs.forEach((cb) => cb(auth)); return; }
    try { await post({ a: "check" }, 2); auth = { ...auth, isEditor: true, viaLink: true }; }
    catch (e) { if (e.code === "permission-denied") cfg.onKeyRejected && cfg.onKeyRejected(e); }
    authCbs.forEach((cb) => cb(auth));
  })();

  setInterval(() => { if (document.visibilityState === "visible") poll(false); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(false); });

  async function saveTags(arr, by) {
    if (!arr.length) return;
    const clean = arr.map((tag) => {
      const c = {};
      for (const [k, v] of Object.entries(tag)) { if ((k.startsWith("_") && k !== "_doc") || k === "photos" || v === undefined) continue; c[k] = v; }
      if (!c._doc) c._doc = rand();
      return c;
    });
    clean.forEach((c) => pending.set(c._doc, c)); emit();
    try {
      const j = await post({ a: "saveTags", tags: clean, by });
      clean.forEach((c) => { tags.set(c._doc, c); pending.delete(c._doc); });
      rev = j.rev; emit();
    } catch (e) { clean.forEach((c) => pending.delete(c._doc)); emit(); throw e; }
  }

  return {
    kind: "gas",
    newId: rand,
    onAuth(cb) { authCbs.push(cb); setTimeout(() => cb(auth), 0); },
    async signIn() { throw Object.assign(new Error("ระบบนี้ใช้ลิงก์แก้ไขแทนการเข้าสู่ระบบ"), { code: "no-login" }); },
    async signOut() {},
    subscribe(cb, onError) {
      subs.push({ cb, onError });
      if (subs.length === 1) poll(true); else if (rev >= 0) setTimeout(() => cb(list(), { pending: pending.size > 0, fromCache: false }), 0);
      return () => { const i = subs.findIndex((s) => s.cb === cb); if (i >= 0) subs.splice(i, 1); };
    },
    async saveTag(tag, photos) {
      const t = { ...tag, _doc: tag._doc || rand() };
      if (photos) t.photoCount = photos.length;
      await saveTags([t]);
      if (photos) await post({ a: "setPhotos", doc: t._doc, photos });
      return t._doc;
    },
    saveTags,
    async deleteTag(doc) { return this.deleteTags([doc]); },
    async deleteTags(docs) {
      if (!docs.length) return;
      docs.forEach((d) => pending.set(d, null)); emit();
      try {
        const j = await post({ a: "deleteTags", docs });
        docs.forEach((d) => { tags.delete(d); pending.delete(d); });
        rev = j.rev; emit();
      } catch (e) { docs.forEach((d) => pending.delete(d)); emit(); throw e; }
    },
    async loadPhotos(doc) { const j = await get({ a: "photos", doc }); return j.photos || []; },
    subscribeMeta(name, cb) {
      (metaSubs[name] ||= []).push(cb);
      fetchMetas([name]);
      return () => { metaSubs[name] = (metaSubs[name] || []).filter((x) => x !== cb); };
    },
    async setMeta(name, data) {
      const j = await post({ a: "setMeta", name, data });
      metaRevs[name] = j.metaRev;
      (metaSubs[name] || []).forEach((cb) => cb({ ...data, serverUpdatedAt: j.metaRev }));
    },
    async setEditors() { throw fail("not-supported"); },
    async getEditors() { return []; },
    refresh() { return poll(true); },
  };
}
