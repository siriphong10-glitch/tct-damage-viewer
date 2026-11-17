// ระบบกริดของท่าเรือ TCT หมายเลข 10 (ตามรูปที่ 3-1 / 3-3 ในรายงาน)
// แนวตัวอักษร A…AP: A–N ห่าง 4.00 ม., N–AP ห่าง 3.50 ม. / แนวตัวเลข 1…15 ห่าง 3.50 ม.
// ระยะตามแบบเป็นค่าเริ่มต้น — การเทียบกับโมเดล (affine) จะแก้ระยะ มุม และตำแหน่งให้เอง

export const LETTERS = (() => {
  const a = [];
  for (let i = 0; i < 26; i++) a.push(String.fromCharCode(65 + i));
  for (let i = 0; i < 16; i++) a.push("A" + String.fromCharCode(65 + i)); // AA…AP
  return a;
})();
export const NUMBERS = Array.from({ length: 15 }, (_, i) => String(i + 1));

// ระยะตามแบบ (ม.) จากแนว A และจากแนว 1
export function letterDist(L) {
  const i = LETTERS.indexOf(String(L).trim().toUpperCase());
  if (i < 0) return null;
  const iN = LETTERS.indexOf("N");
  return i <= iN ? i * 4.0 : iN * 4.0 + (i - iN) * 3.5;
}
export function numDist(n) {
  const k = Number(String(n).trim());
  if (!Number.isFinite(k)) return null;
  return (k - 1) * 3.5;
}
// "A/1", "AB-12", "a 3" → {L, N}
export function parseGridPoint(s) {
  const m = /^\s*([A-Za-z]{1,2})\s*[\/\-\s,]\s*(\d{1,2})\s*$/.exec(s || "");
  if (!m) return null;
  const L = m[1].toUpperCase(), N = m[2];
  if (letterDist(L) == null || numDist(N) == null) return null;
  return { L, N };
}
// ช่วงจากรายงาน: "D/E" → [D,E], "A" → [A]
export function splitRange(s) { return String(s).split("/").map((x) => x.trim()).filter(Boolean); }

// ---- affine fit: [x,y] = A·[u,v] + t, z = c0 + c1·u + c2·v ----
function solve3(M, b) { // Gaussian elimination 3x3
  const a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    if (Math.abs(a[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k]; }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}
function lsq(rows, ys) { // least squares for [1,u,v]
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  rows.forEach((r, i) => { for (let a = 0; a < 3; a++) { b[a] += r[a] * ys[i]; for (let c = 0; c < 3; c++) M[a][c] += r[a] * r[c]; } });
  return solve3(M, b);
}
// pts: [{L,N,x,y,z}] → model or {error}
export function fitGrid(pts) {
  const P = pts.map((p) => ({ ...p, u: letterDist(p.L), v: numDist(p.N) })).filter((p) => p.u != null && p.v != null);
  if (P.length < 3) return { error: "ต้องมีจุดอ้างอิงอย่างน้อย 3 จุด" };
  const rows = P.map((p) => [1, p.u, p.v]);
  const cx = lsq(rows, P.map((p) => p.x)), cy = lsq(rows, P.map((p) => p.y)), cz = lsq(rows, P.map((p) => p.z));
  if (!cx || !cy || !cz) return { error: "จุดอ้างอิงเรียงอยู่ในแนวเดียวกัน — เลือกจุดที่กระจายทั้งสองทิศ" };
  const model = { cx, cy, cz, n: P.length };
  const res = P.map((p) => { const w = toWorld(model, p.u, p.v); return { label: p.L + "/" + p.N, dxy: Math.hypot(w[0] - p.x, w[1] - p.y), dz: w[2] - p.z }; });
  model.residuals = res;
  model.rms = Math.sqrt(res.reduce((a, r) => a + r.dxy * r.dxy, 0) / res.length);
  // ระยะจริงต่อระยะตามแบบ (ตรวจสเกล)
  model.scaleU = Math.hypot(cx[1], cy[1]); model.scaleV = Math.hypot(cx[2], cy[2]);
  const dot = (cx[1] * cx[2] + cy[1] * cy[2]) / (model.scaleU * model.scaleV);
  model.skewDeg = 90 - Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  return model;
}
export function toWorld(model, u, v) {
  const f = (c) => c[0] + c[1] * u + c[2] * v;
  return [f(model.cx), f(model.cy), f(model.cz)];
}
export function gridWorld(model, L, N) {
  const u = letterDist(L), v = numDist(N);
  return u == null || v == null ? null : toWorld(model, u, v);
}
// ตำแหน่งตามที่รายงานเขียน → จุดศูนย์กลาง และกรอบ (ถ้าเป็นช่วงทั้งสองทิศ)
export function locate(model, letterSpec, numSpec) {
  const Ls = splitRange(letterSpec), Ns = splitRange(numSpec);
  const us = Ls.map(letterDist), vs = Ns.map(numDist);
  if (!us.length || !vs.length || us.some((x) => x == null) || vs.some((x) => x == null)) return null;
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const center = toWorld(model, (u0 + u1) / 2, (v0 + v1) / 2);
  const isRect = u1 > u0 && v1 > v0;
  const corners = isRect ? [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => toWorld(model, u, v)) : null;
  return { center, corners, u0, u1, v0, v1, isRect };
}
