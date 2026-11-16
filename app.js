import * as THREE from "./libs/three/three.module.js";

const C = window.APP_CONFIG;
const params = new URLSearchParams(location.search);
// สิทธิ์แก้ไขมาจากการล็อกอิน (ผู้ที่อยู่ในรายชื่อผู้แก้ไข)
let EDIT = false;
let store = null;               // Firebase store (หรือ null = อ่านจาก tags.json อย่างเดียว)
let auth = { user: null, email: "", isEditor: false, isOwner: false, editors: [] };
const photoCache = new Map();   // _doc -> { key, photos }

const SEVERITY = [
  { key: 1, label: "น้อย", color: "#3fb950" },
  { key: 2, label: "ปานกลาง", color: "#d29922" },
  { key: 3, label: "มาก", color: "#f0883e" },
  { key: 4, label: "วิกฤต", color: "#f85149" },
];
const DAMAGE_TYPES = [
  "รอยร้าว",
  "คอนกรีตกะเทาะ / หลุดร่อน",
  "เหล็กเสริมเป็นสนิม / โผล่",
  "การรั่วซึม / คราบน้ำ",
  "การทรุดตัว / การแอ่นตัว",
  "ผิวคอนกรีตเสื่อมสภาพ",
  "การกัดกร่อนของโครงสร้างเหล็ก",
  "ความเสียหายจากการกระแทก",
  "อื่น ๆ",
];
const sev = (k) => SEVERITY.find((s) => s.key === Number(k)) || { label: "-", color: "#888" };

// ---------- state ----------
let data = { version: 1, project: C.projectTitle, tags: [] };
let origin = new THREE.Vector3(); // local origin for overlay geometry (precision)
let overlayGroup = null;
const overlays = new Map(); // id -> {group}
let activeId = null;
let draw = null; // {kind, points:[Vector3], line}
let panelMode = "";      // "detail" | "form" | "editors" | ""
let activeDoc = null;    // _doc ของรายการที่เปิดดูอยู่
let firstLoad = true;

// ---------- helpers ----------
const $id = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 2) => (n === null || n === undefined || n === "" || isNaN(n) ? "-" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: d, maximumFractionDigits: d }));
function toast(msg, ms = 2600) {
  const t = $id("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
// เสนอรหัสถัดไปตามรูปแบบของรายการที่สร้างล่าสุด เช่น D-007 → D-008, C-12 → C-13
function nextId() {
  const last = [...data.tags].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))).pop();
  const m0 = last && /^(.*?)(\d+)$/.exec(last.id);
  const prefix = m0 ? m0[1] : "D-";
  const width = m0 ? m0[2].length : 3;
  let max = 0;
  for (const t of data.tags) {
    const m = /^(.*?)(\d+)$/.exec(t.id);
    if (m && m[1] === prefix) max = Math.max(max, +m[2]);
  }
  let n = max + 1, id;
  do { id = prefix + String(n++).padStart(width, "0"); } while (data.tags.some((t) => t.id === id));
  return id;
}
// เรียงรหัสแบบธรรมชาติ (D-2 มาก่อน D-10)
const byId = (a, b) => a.id.localeCompare(b.id, "th", { numeric: true, sensitivity: "base" });
function today() { const d = new Date(); return d.toISOString().slice(0, 10); }

// ---------- geometry ----------
// พื้นที่จริงของรูปหลายเหลี่ยมในสามมิติ (Newell) — ใช้ได้ทั้งพื้น ผนัง และผิวเอียง
export function polygonMetrics(pts) {
  const n = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
    c.add(a);
  }
  c.divideScalar(pts.length);
  const area = n.length() / 2;
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) perimeter += pts[i].distanceTo(pts[(i + 1) % pts.length]);
  const normal = n.lengthSq() > 0 ? n.clone().normalize() : new THREE.Vector3(0, 0, 1);
  // ฐานพิกัดบนระนาบ แล้วหาแกนหลักด้วย PCA เพื่อวัดความยาว/ความกว้าง
  const tmp = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const u0 = new THREE.Vector3().crossVectors(tmp, normal).normalize();
  const v0 = new THREE.Vector3().crossVectors(normal, u0).normalize();
  const p2 = pts.map((p) => { const d = p.clone().sub(c); return [d.dot(u0), d.dot(v0)]; });
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of p2) { sxx += x * x; syy += y * y; sxy += x * y; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ax = [Math.cos(ang), Math.sin(ang)], ay = [-Math.sin(ang), Math.cos(ang)];
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const [x, y] of p2) {
    const a = x * ax[0] + y * ax[1], b = x * ay[0] + y * ay[1];
    minA = Math.min(minA, a); maxA = Math.max(maxA, a); minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }
  const L = maxA - minA, W = maxB - minB;
  const tilt = Math.acos(Math.min(1, Math.abs(normal.z))) * 180 / Math.PI; // 0 = แนวราบ, 90 = แนวดิ่ง
  return { area, perimeter, length: Math.max(L, W), width: Math.min(L, W), centroid: c, normal, p2, tilt };
}

// ---------- viewer ----------
const viewer = new Potree.Viewer($id("potree_render_area"));
window.viewer = viewer;
viewer.setEDLEnabled(false);
viewer.setFOV(60);
viewer.setBackground("gradient");
const coarse = matchMedia("(pointer:coarse)").matches;
viewer.setPointBudget(coarse ? C.pointBudgetMobile : C.pointBudgetDesktop);
viewer.setMinNodeSize(30);

$id("projTitle").textContent = C.projectTitle;
document.title = C.projectTitle;
function applyAuth() {
  EDIT = !!auth.isEditor;
  $id("modeBadge").hidden = !EDIT;
  if (!draw) $id("editbar").hidden = !EDIT;
  const b = $id("btnLogin");
  if (!store) { b.hidden = true; return; }
  b.hidden = false;
  if (!auth.user) { b.textContent = "เข้าสู่ระบบ"; b.title = "เข้าสู่ระบบเพื่อแก้ไข (เฉพาะผู้ที่ได้รับสิทธิ์)"; }
  else { b.textContent = auth.email.split("@")[0] + (EDIT ? "" : " (ดูอย่างเดียว)"); b.title = auth.email + " — กดเพื่อดูตัวเลือก"; }
  $id("menuEditors").hidden = !auth.isOwner;
  if (panelMode === "detail" && activeDoc) { const t = data.tags.find((x) => x._doc === activeDoc); if (t) showDetail(t.id); }
  renderList();
}

Potree.loadPointCloud(C.pointCloudUrl, "cloud", (e) => {
  const pc = e.pointcloud;
  viewer.scene.addPointCloud(pc);
  const m = pc.material;
  m.size = 1;
  m.pointSizeType = Potree.PointSizeType.ADAPTIVE;
  try { m.activeAttributeName = "rgba"; } catch (_) {}
  origin.copy(pc.position);
  overlayGroup = new THREE.Group();
  overlayGroup.position.copy(origin);
  viewer.scene.scene.add(overlayGroup);

  const sv = C.startView;
  if (sv && params.get("tag") == null) {
    viewer.scene.view.position.set(sv.x, sv.y, sv.z);
    viewer.scene.view.yaw = sv.yaw; viewer.scene.view.pitch = sv.pitch;
    viewer.scene.view.radius = 40;
  } else {
    viewer.fitToScreen();
  }
  $id("loading").hidden = true;
  loadTags();
});
setTimeout(() => { if (!$id("loading").hidden) $id("loading").textContent = "กำลังโหลดโมเดล… (ถ้านานผิดปกติ ให้ตรวจการเชื่อมต่ออินเทอร์เน็ต)"; }, 15000);

async function loadTags() {
  if (C.mockStore || C.firebase) {
    try {
      if (C.mockStore) store = (await import(C.mockStore)).createMockStore(C);
      else store = (await import("./libs/store.bundle.js")).createFirebaseStore(C);
    } catch (e) { console.error(e); store = null; toast("เชื่อมต่อฐานข้อมูลไม่ได้ — แสดงข้อมูลสำรอง", 5000); }
  }
  if (!store) {
    try { const r = await fetch(C.tagsUrl, { cache: "no-cache" }); if (r.ok) onTags(normalize(await r.json()).tags, {}); } catch (_) {}
    if (firstLoad) onTags([], {});
    applyAuth();
    return;
  }
  store.onAuth((a) => { auth = a; applyAuth(); });
  store.subscribe(onTags, (e) => { console.error(e); setSync("err", "โหลดข้อมูลไม่ได้"); });
  applyAuth();
}
function onTags(tags, meta) {
  data.tags = tags.filter((t) => t && t.id && Array.isArray(t.position)).sort(byId);
  rebuildAll();
  if (store) {
    if (meta.pending) setSync("busy", "กำลังบันทึก…");
    else if (meta.fromCache && !navigator.onLine) setSync("off", "ออฟไลน์ — จะบันทึกขึ้นออนไลน์เมื่อมีสัญญาณ");
    else setSync("ok", EDIT ? "บันทึกออนไลน์แล้ว" : "ข้อมูลล่าสุด");
  }
  // อัปเดตรายละเอียดที่เปิดอยู่ ถ้ามีคนอื่นแก้
  if (panelMode === "detail" && activeDoc) {
    const t = data.tags.find((x) => x._doc === activeDoc);
    if (t) showDetail(t.id); else { closePanel(); toast("รายการที่เปิดอยู่ถูกลบแล้ว"); }
  }
  if (firstLoad) {
    firstLoad = false;
    if (innerWidth > 900 && data.tags.length) setListOpen(true);
    const tid = params.get("tag");
    if (tid) { const t = data.tags.find((x) => x.id === tid); if (t) { flyTo(t, false); showDetail(t.id); } else viewer.fitToScreen(); }
  }
}
function setSync(state, text) {
  const el = $id("syncState");
  el.hidden = false; el.dataset.state = state; el.textContent = text;
}
function normalize(d) {
  if (Array.isArray(d)) d = { version: 1, tags: d };
  d.tags = (d.tags || []).filter((t) => t && t.id && t.position);
  d.project = d.project || C.projectTitle;
  return d;
}
// เขียนลงฐานข้อมูล — หน้าจอจะอัปเดตเองจากข้อมูลที่ซิงก์กลับมา
async function writeTag(t, photos) {
  try { await store.saveTag(t, photos); }
  catch (e) { console.error(e); toast(e?.code === "permission-denied" ? "บันทึกไม่สำเร็จ: บัญชีนี้ไม่มีสิทธิ์แก้ไข" : "บันทึกไม่สำเร็จ: " + (e?.message || e), 6000); throw e; }
}
async function getPhotos(t) {
  if (!t._doc || !store || !t.photoCount) return t.photos || [];
  const key = t._doc + "|" + (t.updatedAt || "") + "|" + t.photoCount;
  const c = photoCache.get(t._doc);
  if (c && c.key === key) return c.photos;
  const photos = await store.loadPhotos(t._doc);
  photoCache.set(t._doc, { key, photos });
  return photos;
}

// ---------- overlay geometry ----------
// ให้พื้นที่ที่วาดถูกบังโดยผิวโมเดลที่อยู่ด้านหน้า (ไม่โปร่งแสง)
// ดึงเข้าหากล้องเล็กน้อย (0.4% ของระยะ) เพื่อไม่ให้จุดของผิวเดียวกันบังตัวเอง
const DEPTH_PULL = 0.004;
function occludable(mat) {
  mat.depthTest = true;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <project_vertex>",
      `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
       mvPosition.xyz *= ${(1 - DEPTH_PULL).toFixed(4)};
       gl_Position = projectionMatrix * mvPosition;`);
  };
  return mat;
}
function toLocal(arr) { return new THREE.Vector3(arr[0], arr[1], arr[2]).sub(origin); }
function buildOverlay(t) {
  removeOverlay(t.id);
  if (t.kind !== "area" || !t.points || t.points.length < 3 || !overlayGroup) return;
  const color = new THREE.Color(sev(t.severity).color);
  const g = new THREE.Group();
  const loc = t.points.map(toLocal);
  const lineGeo = new THREE.BufferGeometry().setFromPoints([...loc, loc[0]]);
  const line = new THREE.Line(lineGeo, occludable(new THREE.LineBasicMaterial({ color, transparent: true })));
  line.renderOrder = 10;
  g.add(line);
  const mtr = polygonMetrics(t.points.map((p) => new THREE.Vector3(...p)));
  const contour = mtr.p2.map(([x, y]) => new THREE.Vector2(x, y));
  let tris = [];
  try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (_) {}
  if (tris.length) {
    const pos = [];
    for (const tri of tris) for (const i of tri) pos.push(loc[i].x, loc[i].y, loc[i].z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const mesh = new THREE.Mesh(geo, occludable(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })));
    mesh.renderOrder = 9;
    g.add(mesh);
  }
  overlayGroup.add(g);
  overlays.set(t.id, g);
}
function removeOverlay(id) {
  const g = overlays.get(id);
  if (g) { overlayGroup.remove(g); g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); overlays.delete(id); }
}
function rebuildAll() {
  refreshOcclusion();
  for (const id of [...overlays.keys()]) removeOverlay(id);
  data.tags.forEach(buildOverlay);
  renderLabels(true);
  $id("tagCount").textContent = data.tags.length;
  renderList();
}

// ---------- labels (HTML overlay) ----------
const labelEls = new Map();
function renderLabels(rebuild = false) {
  const host = $id("labels");
  if (rebuild) {
    host.innerHTML = ""; labelEls.clear();
    for (const t of data.tags) {
      const el = document.createElement("div");
      el.className = "tag-label";
      el.innerHTML = `<span class="chip" style="background:${sev(t.severity).color}">${esc(t.id)}</span><span class="stem"></span><span class="pin"></span>`;
      el.addEventListener("click", (ev) => { ev.stopPropagation(); showDetail(t.id); });
      host.appendChild(el); labelEls.set(t.id, el);
    }
    draw?.vertexEls?.forEach((v) => host.appendChild(v));
  }
}
const _v = new THREE.Vector3();
function project(arr, cam, w, h) {
  _v.set(arr[0], arr[1], arr[2]);
  _v.applyMatrix4({ elements: cam.matrixWorldInverse.elements }).applyMatrix4({ elements: cam.projectionMatrix.elements });
  return { x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, vis: _v.z < 1 && _v.z > -1 };
}
// ---------- occlusion (ซ่อนป้ายที่อยู่หลังผิวโมเดล) ----------
// ยิงตรวจจากกล้องไปยังตำแหน่งป้าย ถ้าเจอผิวโมเดลก่อนถึงป้ายเกินค่าเผื่อ = ป้ายถูกบัง
const occluded = new Map();      // id -> true/false
let occQueue = [];
let lastCamKey = "", camStillSince = 0, occDoneFor = "";
const _ray = new THREE.Raycaster();
function pickAt(x, y, win) {
  const cam = viewer.scene.getActiveCamera();
  const el = viewer.renderer.domElement;
  _ray.setFromCamera({ x: (x / el.clientWidth) * 2 - 1, y: -(y / el.clientHeight) * 2 + 1 }, cam);
  let best = null;
  for (const pc of viewer.scene.pointclouds) {
    const pt = pc.pick(viewer, cam, _ray.ray, { x, y: el.clientHeight - y, pickWindowSize: win, pickClipped: true });
    if (!pt) continue;
    const d = cam.position.distanceTo(pt.position);
    if (!best || d < best) best = d;
  }
  return best;
}
function testOcclusion(t, cam, w, h) {
  const p = project(t.position, cam, w, h);
  if (!p.vis || p.x < 0 || p.y < 0 || p.x > w || p.y > h) return false;
  const tagDist = cam.position.distanceTo(_v.set(...t.position));
  const hit = pickAt(p.x, p.y, 9);
  if (hit == null) return false;
  const tol = Math.max(0.2, 0.015 * tagDist);
  return hit < tagDist - tol;
}
function updateOcclusion(cam, w, h) {
  const e = cam.matrixWorld.elements;
  const key = e.map((v) => v.toFixed(3)).join(",") + w + "x" + h;
  const now = performance.now();
  if (key !== lastCamKey) { lastCamKey = key; camStillSince = now; occQueue = []; return; }
  // ตรวจเมื่อกล้องหยุดนิ่ง แล้วตรวจซ้ำอีกครั้งหลังโมเดลโหลดรายละเอียดเพิ่ม
  const stage = now - camStillSince > 1500 ? "2" : now - camStillSince > 120 ? "1" : "";
  if (stage && occDoneFor !== key + stage && !occQueue.length) { occDoneFor = key + stage; occQueue = data.tags.map((t) => t.id); }
  for (let i = 0; i < 4 && occQueue.length; i++) {
    const t = data.tags.find((x) => x.id === occQueue.shift());
    if (t) occluded.set(t.id, testOcclusion(t, cam, w, h));
  }
}
function refreshOcclusion() { occDoneFor = ""; occQueue = []; }

function tick() {
  const cam = viewer.scene.getActiveCamera();
  const host = $id("labels");
  const w = host.clientWidth, h = host.clientHeight;
  if (cam && cam.matrixWorldInverse) {
    if (viewer.scene.pointclouds.length && data.tags.length) { try { updateOcclusion(cam, w, h); } catch (_) {} }
    for (const t of data.tags) {
      const el = labelEls.get(t.id); if (!el) continue;
      const p = project(t.position, cam, w, h);
      el.style.display = p.vis ? "" : "none";
      el.style.left = p.x + "px"; el.style.top = p.y + "px";
      el.classList.toggle("active", t.id === activeId);
      el.classList.toggle("occluded", !!occluded.get(t.id) && t.id !== activeId);
    }
    if (draw) draw.points.forEach((pt, i) => {
      const el = draw.vertexEls[i]; const p = project([pt.x, pt.y, pt.z], cam, w, h);
      el.style.display = p.vis ? "" : "none"; el.style.left = p.x + "px"; el.style.top = p.y + "px";
    });
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- camera ----------
function flyTo(t, animate = true) {
  const target = new THREE.Vector3(...t.position);
  let camPos = t.camera?.position ? new THREE.Vector3(...t.camera.position) : null;
  if (!camPos) {
    const v = viewer.scene.view;
    const dir = target.clone().sub(v.position).normalize();
    camPos = target.clone().sub(dir.multiplyScalar(12));
  }
  if (animate && Potree.Utils.moveTo) Potree.Utils.moveTo(viewer.scene, camPos, target);
  else { viewer.scene.view.position.copy(camPos); viewer.scene.view.lookAt(target); }
}

// ---------- picking / drawing ----------
const canvas = viewer.renderer.domElement;
let down = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = performance.now() - down.t < 500;
  down = null;
  if (!draw || moved > 6 || !quick) return;
  const rect = canvas.getBoundingClientRect();
  const mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const hit = Potree.Utils.getMousePointCloudIntersection(mouse, viewer.scene.getActiveCamera(), viewer, viewer.scene.pointclouds, { pickClipped: true });
  if (!hit) { toast("ไม่พบจุดของโมเดลตรงนั้น ลองแตะใหม่"); return; }
  addDrawPoint(new THREE.Vector3(hit.location.x, hit.location.y, hit.location.z));
});

function startDraw(kind) {
  closePanel(); hideMenus();
  cancelDraw();
  draw = { kind, points: [], vertexEls: [], line: null };
  $id("editbar").hidden = true; $id("drawbar").hidden = false;
  $id("btnUndoPt").hidden = kind === "pin";
  $id("btnFinish").hidden = kind === "pin";
  $id("drawHint").textContent = kind === "pin" ? "แตะตำแหน่งความเสียหายบนโมเดล" : "แตะมุมของพื้นที่ทีละจุด (อย่างน้อย 3 จุด) แล้วกด เสร็จ";
}
function addDrawPoint(p) {
  if (draw.kind === "pin") {
    const pos = [p.x, p.y, p.z];
    finishDraw({ position: pos });
    return;
  }
  draw.points.push(p);
  const el = document.createElement("div"); el.className = "draw-vertex";
  $id("labels").appendChild(el); draw.vertexEls.push(el);
  updateDrawLine();
  if (draw.points.length >= 3) {
    const m = polygonMetrics(draw.points);
    $id("drawHint").textContent = `${draw.points.length} จุด · พื้นที่ ≈ ${fmt(m.area)} ตร.ม.`;
  } else $id("drawHint").textContent = `${draw.points.length} จุด — แตะเพิ่มอีก`;
}
function updateDrawLine() {
  if (draw.line) { overlayGroup.remove(draw.line); draw.line.geometry.dispose(); draw.line = null; }
  if (draw.points.length < 2) return;
  const loc = draw.points.map((p) => p.clone().sub(origin));
  if (loc.length >= 3) loc.push(loc[0]);
  draw.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loc), new THREE.LineBasicMaterial({ color: 0x2f81f7, depthTest: false }));
  draw.line.renderOrder = 11;
  overlayGroup.add(draw.line);
}
function undoPoint() {
  if (!draw || !draw.points.length) return;
  draw.points.pop(); draw.vertexEls.pop()?.remove(); updateDrawLine();
  $id("drawHint").textContent = `${draw.points.length} จุด`;
}
function cancelDraw() {
  if (!draw) return;
  draw.vertexEls.forEach((e) => e.remove());
  if (draw.line) { overlayGroup.remove(draw.line); draw.line.geometry.dispose(); }
  draw = null;
  $id("drawbar").hidden = true; if (EDIT) $id("editbar").hidden = false;
}
function finishDraw(extra) {
  const v = viewer.scene.view;
  let t;
  if (draw.kind === "pin") {
    t = { kind: "pin", position: extra.position };
  } else {
    if (draw.points.length < 3) { toast("ต้องมีอย่างน้อย 3 จุด"); return; }
    const m = polygonMetrics(draw.points);
    t = {
      kind: "area",
      points: draw.points.map((p) => [r3(p.x), r3(p.y), r3(p.z)]),
      position: [r3(m.centroid.x), r3(m.centroid.y), r3(m.centroid.z)],
      area: r3(m.area), perimeter: r3(m.perimeter), length: r3(m.length), width: r3(m.width), tilt: Math.round(m.tilt),
    };
  }
  t.position = t.position.map(r3);
  t.camera = { position: [v.position.x, v.position.y, v.position.z].map(r3) };
  cancelDraw();
  showForm(null, t);
}
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---------- panel ----------
function openPanel(title, html) {
  $id("panelTitle").textContent = title;
  $id("panelBody").innerHTML = html;
  $id("panel").hidden = false; $id("legend").hidden = true;
  document.body.classList.add("panel-open");
}
function closePanel() { $id("panel").hidden = true; document.body.classList.remove("panel-open"); activeId = null; activeDoc = null; panelMode = ""; renderList(); }

function showDetail(id) {
  const t = data.tags.find((x) => x.id === id); if (!t) return;
  activeId = id; activeDoc = t._doc || null; panelMode = "detail";
  renderList();
  const s = sev(t.severity);
  const rows = [
    ["ประเภท", esc(t.type)],
    ["ระดับความรุนแรง", `<span class="sev-pill" style="background:${s.color}">${s.label}</span>`],
    ["ตำแหน่ง / องค์อาคาร", esc(t.element || "-")],
  ];
  if (t.kind === "area") {
    rows.push(["พื้นที่ (วัดจากโมเดล)", `${fmt(t.area)} ตร.ม.`]);
    rows.push(["ขนาดโดยประมาณ", `${fmt(t.length)} × ${fmt(t.width)} ม.`]);
    rows.push(["เส้นรอบรูป", `${fmt(t.perimeter)} ม.`]);
    rows.push(["ลักษณะผิว", tiltText(t.tilt)]);
  }
  if (t.dimL || t.dimW || t.dimD) rows.push(["ขนาดที่วัดเพิ่ม", [t.dimL && `ยาว ${t.dimL} ม.`, t.dimW && `กว้าง ${t.dimW} ม.`, t.dimD && `ลึก ${t.dimD} มม.`].filter(Boolean).join(" · ")]);
  if (t.crackWidth) rows.push(["ความกว้างรอยร้าว", `${esc(t.crackWidth)} มม.`]);
  rows.push(["รายละเอียด", esc(t.description || "-")]);
  if (t.note) rows.push(["หมายเหตุ", esc(t.note)]);
  rows.push(["วันที่ตรวจ", esc(t.date || "-")]);
  rows.push(["ผู้ตรวจ", esc(t.inspector || "-")]);
  rows.push(["พิกัด (UTM 47N)", `E ${fmt(t.position[0], 3)}<br>N ${fmt(t.position[1], 3)}<br>Z ${fmt(t.position[2], 3)}`]);
  if (t.updatedBy) rows.push(["แก้ไขล่าสุดโดย", esc(t.updatedBy) + (t.updatedAt ? `<br><span class="muted">${esc(new Date(t.updatedAt).toLocaleString("th-TH"))}</span>` : "")]);
  const nPhotos = t.photoCount ?? (t.photos || []).length;
  const photos = nPhotos ? `<div class="photos" id="dPhotos"><span class="muted">กำลังโหลดรูป ${nPhotos} รูป…</span></div>` : "";
  const html = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${photos}
    <div class="actions">
      <button class="btn" id="dFly">ไปที่ตำแหน่งนี้</button>
      <button class="btn" id="dLink">คัดลอกลิงก์</button>
      ${EDIT ? `<button class="btn primary" id="dEdit">แก้ไข</button><button class="btn danger" id="dDel">ลบ</button>` : ""}
    </div>`;
  openPanel(`${t.id} · ${t.kind === "area" ? "พื้นที่ความเสียหาย" : "จุดความเสียหาย"}`, html);
  panelMode = "detail";
  $id("dFly").onclick = () => flyTo(t);
  $id("dLink").onclick = () => copyLink(t.id);
  if (nPhotos) getPhotos(t).then((ps) => {
    const box = $id("dPhotos"); if (!box || activeDoc !== (t._doc || null)) return;
    box.innerHTML = ps.map((p, i) => `<img src="${p}" alt="รูปที่ ${i + 1}">`).join("");
    box.querySelectorAll("img").forEach((img) => img.onclick = () => lightbox(img.src));
  }).catch(() => { const box = $id("dPhotos"); if (box) box.innerHTML = `<span class="muted">โหลดรูปไม่ได้</span>`; });
  if (EDIT) {
    $id("dEdit").onclick = () => showForm(t.id);
    const del = $id("dDel");
    del.onclick = () => {
      if (del.dataset.armed) {
        closePanel();
        store.deleteTag(t._doc).then(() => toast(`ลบ ${t.id} แล้ว`), (e) => toast(e?.code === "permission-denied" ? "ลบไม่สำเร็จ: ไม่มีสิทธิ์" : "ลบไม่สำเร็จ", 5000));
      } else { del.dataset.armed = "1"; del.textContent = "กดอีกครั้งเพื่อยืนยันการลบ"; }
    };
  }
}
function tiltText(tilt) {
  if (tilt == null) return "-";
  if (tilt <= 15) return `แนวราบ (ทำมุม ${tilt}° กับแนวราบ)`;
  if (tilt >= 75) return `แนวดิ่ง (ทำมุม ${tilt}° กับแนวราบ)`;
  return `ผิวเอียง (ทำมุม ${tilt}° กับแนวราบ)`;
}
function copyLink(id) {
  const u = new URL(location.href); u.search = ""; u.searchParams.set("tag", id);
  const s = u.toString();
  (navigator.clipboard?.writeText(s) || Promise.reject()).then(() => toast("คัดลอกลิงก์แล้ว"), () => toast(s, 6000));
}
function lightbox(src) {
  const lb = document.createElement("div"); lb.id = "lightbox"; lb.innerHTML = `<img src="${src}">`;
  lb.onclick = () => lb.remove(); document.body.appendChild(lb);
}

// ---------- form ----------
function showForm(id, draftTag) {
  const isNew = !id;
  const t = isNew ? { ...draftTag, id: nextId(), date: today(), photos: [] } : structuredClone(data.tags.find((x) => x.id === id));
  const oldId = isNew ? null : t.id;
  activeId = t.id; activeDoc = t._doc || null;
  let photosChanged = isNew, photosReady = isNew;
  if (!isNew) t.photos = [];
  const opt = (arr, val) => arr.map((a) => `<option ${a === val ? "selected" : ""}>${esc(a)}</option>`).join("");
  const sevOpt = SEVERITY.map((s) => `<option value="${s.key}" ${Number(t.severity) === s.key ? "selected" : ""}>${s.key} — ${s.label}</option>`).join("");
  const areaInfo = t.kind === "area"
    ? `<label>พื้นที่ (คำนวณจากโมเดล)</label><input value="${fmt(t.area)} ตร.ม. · ${fmt(t.length)} × ${fmt(t.width)} ม." disabled>
       <div class="auto">คำนวณบนระนาบของพื้นที่ที่วาด (${tiltText(t.tilt)}) จึงใช้ได้ทั้งพื้น ผนัง และผิวเอียง</div>` : "";
  const html = `<form class="form" id="tagForm" autocomplete="off">
    <label>รหัสความเสียหาย *</label>
    <input name="tagId" value="${esc(t.id)}" required maxlength="30" placeholder="เช่น D-001 หรือ C-12">
    <div class="auto" id="idMsg">ตั้งให้ตรงกับเลขรันในรายงานได้ ห้ามซ้ำกับรายการอื่น</div>
    <label>ประเภทความเสียหาย *</label>
    <select name="type" required><option value="">— เลือก —</option>${opt(DAMAGE_TYPES, t.type)}</select>
    <label>ระดับความรุนแรง *</label>
    <select name="severity" required><option value="">— เลือก —</option>${sevOpt}</select>
    <label>ตำแหน่ง / องค์อาคาร</label>
    <input name="element" value="${esc(t.element)}" placeholder="เช่น คานท่าเทียบเรือ แนว B3, พื้นลานกองตู้">
    ${areaInfo}
    <label>ขนาดที่วัดเพิ่ม (ถ้ามี)</label>
    <div class="row3">
      <input name="dimL" inputmode="decimal" value="${esc(t.dimL)}" placeholder="ยาว (ม.)">
      <input name="dimW" inputmode="decimal" value="${esc(t.dimW)}" placeholder="กว้าง (ม.)">
      <input name="dimD" inputmode="decimal" value="${esc(t.dimD)}" placeholder="ลึก (มม.)">
    </div>
    <div id="crackRow" ${t.type === "รอยร้าว" ? "" : "hidden"}>
      <label>ความกว้างรอยร้าว (มม.)</label>
      <input name="crackWidth" inputmode="decimal" value="${esc(t.crackWidth)}" placeholder="เช่น 0.3">
    </div>
    <label>รายละเอียดความเสียหาย</label>
    <textarea name="description" placeholder="ลักษณะ รูปแบบ สาเหตุที่สันนิษฐาน">${esc(t.description)}</textarea>
    <label>หมายเหตุ</label>
    <textarea name="note" placeholder="ข้อเสนอแนะ หรือสิ่งที่ต้องตรวจเพิ่ม">${esc(t.note)}</textarea>
    <div class="row2">
      <div><label>วันที่ตรวจ</label><input type="date" name="date" value="${esc(t.date)}"></div>
      <div><label>ผู้ตรวจ</label><input name="inspector" value="${esc(t.inspector || lastInspector())}"></div>
    </div>
    <label>รูปถ่าย (ไม่บังคับ)</label>
    <input type="file" id="photoInput" accept="image/*" multiple>
    <div class="photos" id="photoList"></div>
    <div class="actions">
      <button class="btn primary" type="submit">บันทึก</button>
      <button class="btn" type="button" id="fCancel">ยกเลิก</button>
    </div>
  </form>`;
  openPanel(isNew ? `เพิ่ม ${t.id}` : `แก้ไข ${t.id}`, html);
  panelMode = "form";
  const form = $id("tagForm");
  form.type.onchange = () => ($id("crackRow").hidden = form.type.value !== "รอยร้าว");
  const renderPhotos = () => {
    $id("photoList").innerHTML = t.photos.map((p, i) => `<div class="photo-wrap"><img src="${p}"><button type="button" class="btn rm" data-i="${i}">✕</button></div>`).join("");
    $id("photoList").querySelectorAll(".rm").forEach((b) => b.onclick = () => { t.photos.splice(+b.dataset.i, 1); photosChanged = true; renderPhotos(); });
  };
  renderPhotos();
  if (!isNew) {
    const orig = data.tags.find((x) => x.id === id);
    if (orig.photoCount) $id("photoList").innerHTML = `<span class="muted">กำลังโหลดรูปเดิม…</span>`;
    getPhotos(orig).then((ps) => { if (!photosChanged) { t.photos = [...ps]; } photosReady = true; if ($id("tagForm") === form) renderPhotos(); })
      .catch(() => { photosReady = false; $id("photoList").innerHTML = `<span class="muted">โหลดรูปเดิมไม่ได้ — รูปเดิมจะไม่ถูกเปลี่ยน</span>`; });
  }
  $id("photoInput").onchange = async (e) => {
    for (const f of e.target.files) { try { t.photos.push(await resizeImage(f)); photosChanged = true; } catch (_) { toast("อ่านรูปไม่ได้: " + f.name); } }
    e.target.value = ""; renderPhotos();
  };
  $id("fCancel").onclick = () => { if (isNew) closePanel(); else showDetail(t.id); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    for (const k of ["type", "severity", "element", "dimL", "dimW", "dimD", "crackWidth", "description", "note", "date", "inspector"]) t[k] = (fd.get(k) ?? "").toString().trim();
    t.severity = Number(t.severity);
    const newId = (fd.get("tagId") ?? "").toString().trim();
    const idErr = !newId ? "กรุณาใส่รหัส"
      : /[?#&/\\"<>]/.test(newId) ? "รหัสห้ามมีอักขระ ? # & / \\ \" < >"
      : data.tags.some((x) => x.id.toLowerCase() === newId.toLowerCase() && x.id !== oldId) ? `รหัส ${newId} มีอยู่แล้ว`
      : "";
    if (idErr) { const m = $id("idMsg"); m.textContent = idErr; m.style.color = "#f85149"; form.tagId.focus(); return; }
    t.id = newId;
    if (t.type !== "รอยร้าว") delete t.crackWidth;
    t.updatedAt = new Date().toISOString();
    if (isNew) { t.createdAt = t.updatedAt; t._doc = store.newId(); }
    try { localStorage.setItem("dmgtags-inspector", t.inspector); } catch (_) {}
    const photos = (photosChanged && (isNew || photosReady)) ? t.photos : null;
    if (photos) photoCache.set(t._doc, { key: t._doc + "|" + t.updatedAt + "|" + photos.length, photos: [...photos] });
    const btn = form.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "กำลังบันทึก…";
    const saving = writeTag({ ...t, photos: undefined, photoCount: photos ? photos.length : t.photoCount }, photos);
    // แสดงผลทันที (ข้อมูลในเครื่องอัปเดตก่อน แล้วซิงก์ขึ้นออนไลน์ตามหลัง)
    activeDoc = t._doc; panelMode = "detail";
    setTimeout(() => { const nt = data.tags.find((x) => x._doc === t._doc); if (nt) showDetail(nt.id); }, 50);
    saving.then(() => toast(`บันทึก ${t.id} ออนไลน์แล้ว`), () => { if ($id("tagForm") === form) { btn.disabled = false; btn.textContent = "บันทึก"; } });
  };
}
function lastInspector() { try { return localStorage.getItem("dmgtags-inspector") || ""; } catch (_) { return ""; } }
// ย่อรูปให้ไม่เกิน ~800 KB ต่อรูป (ข้อจำกัดของฐานข้อมูล)
function resizeImage(file, max = 1600, q = 0.8) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let m = max, qq = q, out = "";
      for (let i = 0; i < 8; i++) {
        const s = Math.min(1, m / Math.max(img.width, img.height));
        const cv = document.createElement("canvas"); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        out = cv.toDataURL("image/jpeg", qq);
        if (out.length < 800000) break;
        if (qq > 0.6) qq -= 0.1; else m = Math.round(m * 0.8);
      }
      res(out);
    };
    img.onerror = rej; img.src = url;
  });
}

// ---------- list ----------
// แถบรายการด้านซ้าย — เปิดค้างไว้ได้ระหว่างดูรายละเอียดทางขวา
let listOpen = false;
function setListOpen(open) {
  listOpen = open;
  $id("listPanel").hidden = !open;
  document.body.classList.toggle("list-open", open);
  $id("btnList").classList.toggle("on", open);
  if (open) renderList();
}
function renderList() {
  if (!listOpen) return;
  const counts = SEVERITY.map((s) => `${s.label} ${data.tags.filter((t) => t.severity === s.key).length}`).join(" · ");
  const totalArea = data.tags.filter((t) => t.kind === "area").reduce((a, t) => a + (t.area || 0), 0);
  $id("listSummary").innerHTML = `ทั้งหมด ${data.tags.length} รายการ · ${counts}<br>พื้นที่ความเสียหายรวม ${fmt(totalArea)} ตร.ม.`;
  const ft = $id("fType").value, fs = $id("fSev").value;
  const items = [...data.tags].sort(byId).filter((t) => (!ft || t.type === ft) && (!fs || t.severity === +fs));
  $id("listItems").innerHTML = items.length ? items.map((t) => `<div class="list-item${t.id === activeId ? " sel" : ""}" data-id="${esc(t.id)}">
      <span class="dot" style="background:${sev(t.severity).color};margin-top:4px"></span>
      <div><b>${esc(t.id)}</b> ${esc(t.type)}<div class="meta">${esc(t.element || "")}${t.kind === "area" ? ` · ${fmt(t.area)} ตร.ม.` : ""}${t.photoCount ? ` · รูป ${t.photoCount}` : ""}</div></div>
    </div>`).join("") : `<p class="muted">${data.tags.length ? "ไม่มีรายการตามตัวกรอง" : (EDIT ? "ยังไม่มีรายการ — กด ＋ ปักหมุด หรือ ▱ วาดพื้นที่" : "ยังไม่มีรายการความเสียหาย")}</p>`;
  $id("listItems").querySelectorAll(".list-item").forEach((el) => el.onclick = () => {
    const t = data.tags.find((x) => x.id === el.dataset.id); flyTo(t); showDetail(t.id);
  });
  $id("listItems").querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
$id("fType").innerHTML = `<option value="">ทุกประเภท</option>${DAMAGE_TYPES.map((d) => `<option>${esc(d)}</option>`).join("")}`;
$id("fSev").innerHTML = `<option value="">ทุกระดับ</option>${SEVERITY.map((s) => `<option value="${s.key}">${s.label}</option>`).join("")}`;
$id("fType").onchange = renderList; $id("fSev").onchange = renderList;
$id("btnCloseList").onclick = () => setListOpen(false);

// ---------- files ----------
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportJson() {
  toast("กำลังรวบรวมข้อมูลและรูป…", 8000);
  const tags = [];
  for (const t of data.tags) {
    const c = { ...t }; delete c._doc; delete c._pending; delete c.serverUpdatedAt;
    try { c.photos = await getPhotos(t); } catch (_) { c.photos = []; }
    tags.push(c);
  }
  download("tags-backup.json", JSON.stringify({ version: 1, project: C.projectTitle, exportedAt: new Date().toISOString(), tags }, null, 1), "application/json");
  toast("ดาวน์โหลดไฟล์สำรองแล้ว", 3000);
}
function exportCsv() {
  const head = ["รหัส", "ชนิด", "ประเภทความเสียหาย", "ระดับความรุนแรง", "ตำแหน่ง/องค์อาคาร", "พื้นที่ (ตร.ม.)", "ยาวจากโมเดล (ม.)", "กว้างจากโมเดล (ม.)",
    "ยาววัดเพิ่ม (ม.)", "กว้างวัดเพิ่ม (ม.)", "ลึก (มม.)", "ความกว้างรอยร้าว (มม.)", "รายละเอียด", "หมายเหตุ", "วันที่ตรวจ", "ผู้ตรวจ", "E", "N", "Z", "จำนวนรูป", "ลิงก์"];
  const base = new URL(location.href); base.search = "";
  const rows = [...data.tags].sort(byId).map((t) => [t.id, t.kind === "area" ? "พื้นที่" : "จุด", t.type, sev(t.severity).label, t.element, t.area ?? "", t.length ?? "", t.width ?? "",
    t.dimL, t.dimW, t.dimD, t.crackWidth, t.description, t.note, t.date, t.inspector, ...t.position, t.photoCount || 0, base + "?tag=" + t.id]);
  const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  download("damage-summary.csv", "﻿" + csv, "text/csv");
}
$id("importFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  let incoming;
  try { incoming = normalize(JSON.parse(await f.text())).tags; } catch (_) { toast("ไฟล์ไม่ถูกต้อง"); e.target.value = ""; return; }
  let n = 0;
  toast(`กำลังนำเข้า ${incoming.length} รายการ…`, 10000);
  for (const t of incoming) {
    const ex = data.tags.find((x) => x.id === t.id);
    const photos = Array.isArray(t.photos) ? t.photos : [];
    const tag = { ...t, _doc: ex?._doc || store.newId(), photos: undefined, photoCount: photos.length };
    try { await writeTag(tag, photos); n++; } catch (_) { break; }
  }
  toast(`นำเข้า ${n} จาก ${incoming.length} รายการแล้ว (รหัสที่ซ้ำจะเขียนทับรายการเดิม)`, 5000);
  e.target.value = "";
};

// ---------- ผู้แก้ไข (เฉพาะเจ้าของ) ----------
function showEditors() {
  let list = [...auth.editors];
  openPanel("จัดการผู้แก้ไข", "");
  panelMode = "editors";
  const draw_ = () => {
    $id("panelBody").innerHTML = `<p class="muted">คนที่ได้ link ดูได้ทุกคน แต่จะเพิ่ม แก้ หรือลบรายการได้เฉพาะบัญชี Google ในรายชื่อนี้ (เจ้าของ ${esc(C.ownerEmail)} แก้ได้เสมอ)</p>
      <div class="form">
        ${list.length ? list.map((e, i) => `<div class="editor-row"><span>${esc(e)}</span><button class="btn" data-i="${i}">ลบ</button></div>`).join("") : `<p class="muted">ยังไม่มีผู้แก้ไขเพิ่มเติม</p>`}
        <label>เพิ่มอีเมล (บัญชี Google)</label>
        <div class="row-add"><input id="edNew" type="email" placeholder="name@gmail.com"><button class="btn" id="edAdd">เพิ่ม</button></div>
        <div class="auto" id="edMsg"></div>
        <div class="actions"><button class="btn primary" id="edSave">บันทึกรายชื่อ</button></div>
      </div>`;
    $id("panelBody").querySelectorAll(".editor-row button").forEach((b) => b.onclick = () => { list.splice(+b.dataset.i, 1); draw_(); });
    $id("edAdd").onclick = () => {
      const v = $id("edNew").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { $id("edMsg").textContent = "รูปแบบอีเมลไม่ถูกต้อง"; return; }
      if (!list.includes(v)) list.push(v);
      draw_();
    };
    $id("edSave").onclick = async () => {
      try { await store.setEditors(list); toast("บันทึกรายชื่อผู้แก้ไขแล้ว"); closePanel(); }
      catch (e) { $id("edMsg").textContent = "บันทึกไม่สำเร็จ: " + (e?.code || e?.message || e); }
    };
  };
  draw_();
}
$id("btnLogin").onclick = async (e) => {
  e.stopPropagation();
  if (!auth.user) {
    try { await store.signIn(); } catch (err) { if (err?.code !== "auth/popup-closed-by-user") toast("เข้าสู่ระบบไม่สำเร็จ: " + (err?.code || err?.message || err), 6000); }
    return;
  }
  const m = $id("userMenu");
  $id("userEmail").textContent = auth.email + (EDIT ? (auth.isOwner ? " · เจ้าของ" : " · ผู้แก้ไข") : " · ไม่มีสิทธิ์แก้ไข");
  m.hidden = !m.hidden;
};
$id("btnLogout").onclick = () => { $id("userMenu").hidden = true; store.signOut(); cancelDraw(); if (panelMode === "form" || panelMode === "editors") closePanel(); };
document.addEventListener("click", (e) => { if (!$id("userMenu").contains(e.target)) $id("userMenu").hidden = true; });
addEventListener("online", () => setSync("busy", "กำลังซิงก์…"));
addEventListener("offline", () => setSync("off", "ออฟไลน์ — จะบันทึกขึ้นออนไลน์เมื่อมีสัญญาณ"));

// ---------- UI wiring ----------
function hideMenus() { $id("moreMenu").hidden = true; $id("legend").hidden = true; }
$id("btnList").onclick = () => { hideMenus(); setListOpen(!listOpen); };
$id("btnLegend").onclick = () => { const l = $id("legend"); l.hidden = !l.hidden; };
$id("legendItems").innerHTML = SEVERITY.map((s) => `<div class="sev-row"><span class="dot" style="background:${s.color}"></span>${s.key} — ${s.label}</div>`).join("");
$id("btnClosePanel").onclick = closePanel;
$id("btnAddPin").onclick = () => startDraw("pin");
$id("btnAddArea").onclick = () => startDraw("area");
$id("btnUndoPt").onclick = undoPoint;
$id("btnFinish").onclick = () => draw && finishDraw();
$id("btnCancelDraw").onclick = cancelDraw;
$id("btnMore").onclick = (e) => { e.stopPropagation(); $id("moreMenu").hidden = !$id("moreMenu").hidden; };
$id("moreMenu").onclick = (e) => {
  const act = e.target.dataset.act; if (!act) return; $id("moreMenu").hidden = true;
  if (act === "export") exportJson();
  if (act === "import") $id("importFile").click();
  if (act === "csv") exportCsv();
  if (act === "editors") showEditors();
};
document.addEventListener("click", (e) => { if (!$id("moreMenu").contains(e.target) && e.target.id !== "btnMore") $id("moreMenu").hidden = true; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (draw) cancelDraw(); else closePanel(); }
  if (e.key === "Enter" && draw?.kind === "area" && document.activeElement === document.body) finishDraw();
});
