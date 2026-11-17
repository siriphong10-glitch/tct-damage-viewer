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
// กริดตั้งฉาก: หมุน + เลื่อน + สเกลแยกสองทิศ (แกนตั้งฉากกันเสมอ) — ทนต่อจุดที่แตะคลาดได้ดีกว่า affine
function fitOrtho(P) {
  let best = null;
  for (const h of [1, -1]) {
    const tryTh = (th) => {
      const c = Math.cos(th), s = Math.sin(th);
      // x = tx + su*(c*u) - sv*h*(s*v) ; y = ty + su*(s*u) + sv*h*(c*v)  → linear in [tx,ty,su,sv]
      const A = [], b = [];
      for (const p of P) { A.push([1, 0, c * p.u, -h * s * p.v]); b.push(p.x); A.push([0, 1, s * p.u, h * c * p.v]); b.push(p.y); }
      const M = Array.from({ length: 4 }, () => Array(4).fill(0)), r = Array(4).fill(0);
      A.forEach((row, i) => { for (let a = 0; a < 4; a++) { r[a] += row[a] * b[i]; for (let k = 0; k < 4; k++) M[a][k] += row[a] * row[k]; } });
      const aug = M.map((row, i) => [...row, r[i]]);
      for (let col = 0; col < 4; col++) {
        let piv = col; for (let k = col + 1; k < 4; k++) if (Math.abs(aug[k][col]) > Math.abs(aug[piv][col])) piv = k;
        [aug[col], aug[piv]] = [aug[piv], aug[col]];
        if (Math.abs(aug[col][col]) < 1e-12) return null;
        for (let k = 0; k < 4; k++) if (k !== col) { const f = aug[k][col] / aug[col][col]; for (let j = col; j < 5; j++) aug[k][j] -= f * aug[col][j]; }
      }
      const [tx, ty, su, sv] = aug.map((row, i) => row[4] / row[i]);
      let e = 0; for (const p of P) { const x = tx + su * c * p.u - sv * h * s * p.v, y = ty + su * s * p.u + sv * h * c * p.v; e += (x - p.x) ** 2 + (y - p.y) ** 2; }
      return { e, th, h, tx, ty, su, sv };
    };
    let cand = null;
    for (let d = -180; d < 180; d += 1) { const r = tryTh(d * Math.PI / 180); if (r && r.su > 0 && r.sv > 0 && (!cand || r.e < cand.e)) cand = r; }
    if (!cand) continue;
    let step = 0.5 * Math.PI / 180;
    for (let it = 0; it < 40; it++) { for (const dd of [-step, step]) { const r = tryTh(cand.th + dd); if (r && r.su > 0 && r.sv > 0 && r.e < cand.e) cand = r; } step *= 0.7; }
    if (!best || cand.e < best.e) best = cand;
  }
  return best;
}
// pts: [{L,N,x,y,z}] → model or {error}
export function fitGrid(pts, opts = {}) {
  if ((opts.mode || "ortho") === "ortho") {
    const P = pts.map((p) => ({ ...p, u: letterDist(p.L), v: numDist(p.N) })).filter((p) => p.u != null && p.v != null);
    if (P.length < 3) return { error: "ต้องมีจุดอ้างอิงอย่างน้อย 3 จุด" };
    const o = fitOrtho(P);
    const cz = lsq(P.map((p) => [1, p.u, p.v]), P.map((p) => p.z)) || [P.reduce((a, p) => a + p.z, 0) / P.length, 0, 0];
    if (!o) return { error: "คำนวณกริดไม่ได้ — ตรวจชื่อกริดของแต่ละจุด" };
    const c = Math.cos(o.th), s = Math.sin(o.th);
    const model = { kind: "ortho", cx: [o.tx, o.su * c, -o.sv * o.h * s], cy: [o.ty, o.su * s, o.sv * o.h * c], cz, n: P.length, zTable: opts.zTable || null };
    model.scaleU = o.su; model.scaleV = o.sv; model.skewDeg = 0; model.rotDeg = o.th * 180 / Math.PI;
    model.residuals = P.map((p) => { const w = toWorld(model, p.u, p.v); return { label: p.L + "/" + p.N, dxy: Math.hypot(w[0] - p.x, w[1] - p.y), dz: w[2] - p.z }; });
    model.rms = Math.sqrt(model.residuals.reduce((a, r) => a + r.dxy * r.dxy, 0) / model.residuals.length);
    return model;
  }
  return fitAffine(pts);
}
export function fitAffine(pts) {
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
  const z = model.zTable ? zFromTable(model.zTable, u, v) : null;
  return [f(model.cx), f(model.cy), z ?? f(model.cz)];
}
// ระดับผิวท่าที่วัดจาก point cloud ที่จุดตัดกริด {"A/1": 1.30, ...} → ประมาณค่าเชิงเส้นภายในช่อง
const U_LIST = LETTERS.map((L) => letterDist(L));
function bracket(list, x) {
  if (x <= list[0]) return [0, 0, 0];
  for (let i = 0; i < list.length - 1; i++) if (x <= list[i + 1]) return [i, i + 1, (x - list[i]) / (list[i + 1] - list[i])];
  const n = list.length - 1; return [n, n, 0];
}
export function zFromTable(tab, u, v) {
  const V_LIST = NUMBERS.map((N) => numDist(N));
  const [i0, i1, fu] = bracket(U_LIST, u), [k0, k1, fv] = bracket(V_LIST, v);
  const corners = [[i0, k0, (1 - fu) * (1 - fv)], [i1, k0, fu * (1 - fv)], [i0, k1, (1 - fu) * fv], [i1, k1, fu * fv]];
  let s = 0, w = 0;
  for (const [i, k, wt] of corners) { const z = tab[LETTERS[i] + "/" + NUMBERS[k]]; if (z != null && wt > 0) { s += z * wt; w += wt; } }
  if (w > 0) return s / w;
  // ไม่มีค่าใกล้ ๆ → ใช้จุดที่ใกล้ที่สุดในตาราง
  let best = null, bd = Infinity;
  for (const [key, z] of Object.entries(tab)) { const [L, N] = key.split("/"); const d = Math.hypot(letterDist(L) - u, numDist(N) - v); if (d < bd) { bd = d; best = z; } }
  return best;
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
