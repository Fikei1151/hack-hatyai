// Trees for the 3D city, planted from the satellite imagery.
//
// Tree canopy is told apart from lawns, paddies and water by colour: crowns are green and dark
// (half of every crown sits in its own shade) while grass and rice are green but bright, and canal
// water is pale grey-green. Trees go on a jittered lattice wherever canopy shows and nothing else
// stands (buildings, roads, water). Where canopy is continuous — rubber plantations, orchards, the
// forested hills — and away from the city centre, fewer, larger trees stand in for the real ones,
// keeping the total crown area (stochastic simplification) so the count stays within budget.

import { gaussianBlur } from './raster.mjs';
import { hash01 } from './geo.mjs';

const FINE = 3; // m, analysis grid
const LATTICE = 6; // m, tree spacing in unthinned canopy

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * @param {object} o
 * @param {{x0: number, y0: number, x1: number, y1: number}} o.bounds  domain, local metres
 * @param {{data: Uint8Array, width: number, height: number, channels: number, rect: {x0: number, y0: number, x1: number, y1: number}}[]} o.images
 *   raw RGB imagery (row 0 = north), coarsest first; finer images are blended over coarser ones
 * @param {number[][][]} o.buildings  footprints (trees never stand in them; crowns may overhang a little)
 * @param {number[][][]} o.water  water-body polygons
 * @param {{pts: number[][], half: number, kind: 'road' | 'water'}[]} o.lines  roads and waterways
 * @param {(x: number, y: number) => boolean} o.onLand  false where the terrain was lowered into a canal
 *   or pond bed (wider than the real channel on the 20 m grid): a tree there would stand in the water
 * @param {{x: number, y: number, r0: number, r1: number}} o.focus  full density within r0 of (x, y), fading out by r1
 * @param {number} o.budget  maximum number of trees
 * @param {(...m: unknown[]) => void} [o.log]
 */
export function plantTrees({ bounds, images, buildings, water, lines, onLand, focus, budget, log = () => {} }) {
  const gx = Math.round((bounds.x1 - bounds.x0) / FINE);
  const gy = Math.round((bounds.y1 - bounds.y0) / FINE);
  const G = { nx: gx, ny: gy, cell: FINE, x0: bounds.x0, y0: bounds.y0 };

  // 1. canopy likelihood per image pixel, then on the analysis grid
  const layers = images.map((img) => {
    const mPerPx = (img.rect.x1 - img.rect.x0) / img.width;
    const rgb = blurRgb(img.data, img.width, img.height, img.channels, Math.max(0, Math.round(1.6 / mPerPx)));
    const wide = blurRgb(rgb, img.width, img.height, 3, Math.max(1, Math.round(20 / mPerPx)));
    const n = img.width * img.height;
    const p = new Float32Array(n);
    // haze and cloud: bright and grey at ~40 m scale; the coarser image shows through instead
    const clear = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const r = rgb[k * 3];
      const g = rgb[k * 3 + 1];
      const b = rgb[k * 3 + 2];
      const gli = (2 * g - r - b) / (2 * g + r + b + 1);
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      p[k] = smooth(0.03, 0.09, gli) * (1 - smooth(0.25, 0.33, L));
      const R = wide[k * 3];
      const Gw = wide[k * 3 + 1];
      const B = wide[k * 3 + 2];
      const mx = Math.max(R, Gw, B);
      const sat = (mx - Math.min(R, Gw, B)) / (mx + 1);
      const Lw = (0.299 * R + 0.587 * Gw + 0.114 * B) / 255;
      clear[k] = 1 - smooth(0.44, 0.56, Lw) * (1 - smooth(0.12, 0.22, sat));
    }
    return { ...img, rgb, p, clear };
  });
  /** blended (r, g, b, canopy) at a point, like the terrain shader blends the imagery */
  const sample = (x, y, out) => {
    out[0] = out[1] = out[2] = out[3] = 0;
    for (let l = 0; l < layers.length; l++) {
      const im = layers[l];
      const u = (x - im.rect.x0) / (im.rect.x1 - im.rect.x0);
      const v = (im.rect.y1 - y) / (im.rect.y1 - im.rect.y0);
      if (u <= 0 || v <= 0 || u >= 1 || v >= 1) continue;
      const fi = u * im.width - 0.5;
      const fj = v * im.height - 0.5;
      let w = l === 0 ? 1 : smooth(0, 0.04, Math.min(u, v, 1 - u, 1 - v));
      if (l > 0) w *= bilinear(im.clear, im.width, im.height, fi, fj);
      if (w <= 0) continue;
      const i = Math.min(im.width - 1, Math.max(0, Math.round(fi)));
      const j = Math.min(im.height - 1, Math.max(0, Math.round(fj)));
      const k = (j * im.width + i) * 3;
      out[0] += (im.rgb[k] - out[0]) * w;
      out[1] += (im.rgb[k + 1] - out[1]) * w;
      out[2] += (im.rgb[k + 2] - out[2]) * w;
      out[3] += (bilinear(im.p, im.width, im.height, fi, fj) - out[3]) * w;
    }
    return out;
  };
  const canopy = new Uint8Array(gx * gy);
  const s4 = new Float32Array(4);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) canopy[j * gx + i] = Math.round(sample(G.x0 + (i + 0.5) * FINE, G.y0 + (j + 0.5) * FINE, s4)[3] * 255);

  // 2. where trees cannot stand: bit 1 building, 2 road, 4 water
  const mask = new Uint8Array(gx * gy);
  for (const pts of buildings) fillPolygon(mask, G, pts, 1);
  for (const pts of water) fillPolygon(mask, G, pts, 4);
  for (const l of lines) stampLine(mask, G, l.pts, l.half, l.kind === 'water' ? 4 : 2);
  const bDist = chamfer(mask, gx, gy, 1); // building distance, 1/3 cell units

  // 3. canopy continuity at ~20 m: high in plantations and forest, low among houses
  const C = 4;
  // (rounded up: the domain need not be a multiple of C cells, e.g. 25 km / 3 m)
  const cx = Math.ceil(gx / C);
  const cy = Math.ceil(gy / C);
  const coarse = new Float32Array(cx * cy);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) {
      const k = j * gx + i;
      if (!mask[k]) coarse[Math.floor(j / C) * cx + Math.floor(i / C)] += canopy[k] / 255 / (C * C);
    }
  const cont = gaussianBlur(coarse, cx, cy, 1.5);

  // 4. candidates on a jittered lattice. Near the centre (where the camera spends its time) every
  // candidate in fragmented canopy becomes a tree; continuous canopy and the outskirts are thinned
  // to fit the budget, their trees growing so the crown area they stand for is kept.
  const lx = Math.round((bounds.x1 - bounds.x0) / LATTICE);
  const ly = Math.round((bounds.y1 - bounds.y0) / LATTICE);
  const cand = (i, j, f) => {
    const id = j * lx + i;
    const x = bounds.x0 + (i + hash01(id * 4 + 1)) * LATTICE;
    const y = bounds.y0 + (j + hash01(id * 4 + 2)) * LATTICE;
    const fi = Math.min(gx - 1, Math.floor((x - G.x0) / FINE));
    const fj = Math.min(gy - 1, Math.floor((y - G.y0) / FINE));
    const k = fj * gx + fi;
    const p = canopy[k] / 255;
    if (p < 0.02 || mask[k] || !onLand(x, y)) return;
    const c = bilinear(cont, cx, cy, (x - G.x0) / (FINE * C) - 0.5, (y - G.y0) / (FINE * C) - 0.5);
    const near = smooth(focus.r1, focus.r0, Math.hypot(x - focus.x, y - focus.y));
    f(id, x, y, p, smooth(0.35, 0.75, c), near, k);
  };
  const keepNear = (w) => 1 - 0.55 * w;
  const keepFar = (w) => 0.4 - 0.25 * w;
  let area = 0;
  let fixed = 0;
  let scalable = 0;
  for (let j = 0; j < ly; j++)
    for (let i = 0; i < lx; i++)
      cand(i, j, (id, x, y, p, w, near) => {
        area += p;
        fixed += p * near * keepNear(w);
        scalable += p * (1 - near) * keepFar(w);
      });
  // outskirts take what the centre leaves; if the centre alone is over budget, thin it too
  const farScale = Math.min(1, Math.max(0.02, (budget - fixed) / Math.max(1, scalable)));
  const nearScale = Math.min(1, budget / (fixed + scalable * farScale));
  log(
    `  ${((area * LATTICE * LATTICE) / 1e6).toFixed(1)} km² of tree canopy; ~${Math.round(fixed * nearScale)} trees near the centre, ` +
      `~${Math.round(scalable * farScale * nearScale)} further out (thinned to ${(farScale * 100).toFixed(0)}%, larger crowns)`,
  );

  const xs = [];
  const ys = [];
  const hs = [];
  const rs = [];
  const cols = [];
  for (let j = 0; j < ly; j++)
    for (let i = 0; i < lx; i++)
      cand(i, j, (id, x, y, p, w, near, k) => {
        const keep = nearScale * (near * keepNear(w) + (1 - near) * farScale * keepFar(w));
        if (hash01(id * 4 + 3) >= p * keep) return;
        // a closed canopy at the lattice spacing needs crowns of ~0.6 × spacing; thinned trees grow
        // (drawn as a clump) so the canopy they represent keeps its area, but not taller: height
        // follows the real tree, and plantation and forest trees outgrow garden ones
        const R0 = 2.5 + 1.8 * hash01(id * 7 + 5);
        let R = Math.min(14, R0 / Math.sqrt(keep));
        let H = R0 * (1.8 + 1.0 * hash01(id * 7 + 6)) + 1 + 7 * w;
        const dB = (bDist[k] / 3) * FINE;
        if (dB < 40) {
          R = Math.min(R, 1.25 * dB + 1.2);
          H = Math.min(H, 3 * R + 2);
        }
        // crown colour: imagery averaged over the crown, weighted by how canopy-like each spot is
        let r = 0;
        let g = 0;
        let b = 0;
        let ws = 0;
        for (const [ox, oy] of OFFSETS) {
          sample(x + ox * R, y + oy * R, s4);
          const wt = 0.05 + s4[3];
          r += s4[0] * wt;
          g += s4[1] * wt;
          b += s4[2] * wt;
          ws += wt;
        }
        xs.push(x);
        ys.push(y);
        hs.push(Math.min(25, Math.max(3.5, H)));
        rs.push(Math.max(1.2, R));
        cols.push(r / ws, g / ws, b / ws);
      });

  // random order, so any prefix of any spatial subset is an even thinning of it (distance LOD)
  const n = xs.length;
  const order = Uint32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(hash01(i * 13 + 7) * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const out = { count: n, x: new Float32Array(n), y: new Float32Array(n), height: new Float32Array(n), radius: new Float32Array(n), color: new Uint8Array(n * 3) };
  for (let t = 0; t < n; t++) {
    const s = order[t];
    out.x[t] = xs[s];
    out.y[t] = ys[s];
    out.height[t] = hs[s];
    out.radius[t] = rs[s];
    for (let c = 0; c < 3; c++) out.color[t * 3 + c] = Math.round(cols[s * 3 + c]);
  }
  return out;
}

const OFFSETS = [
  [0, 0],
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
];

/**
 * trees.bin — 'HYT2', count, origin x/y (float32, local m), then per-tree arrays: x, y (int16, 0.5 m
 * from the origin), height, crown radius (uint8, 0.1 m), crown colour from the imagery (sRGB bytes).
 * Trees are in random order. (HYT1 had no origin and 0.25 m units, i.e. only ±8 km.)
 */
export function encodeTrees(t, origin = { x: 0, y: 0 }) {
  const n = t.count;
  const pad4 = (v) => (v + 3) & ~3;
  const offX = 16;
  const offY = offX + pad4(n * 2);
  const offH = offY + pad4(n * 2);
  const offR = offH + pad4(n);
  const offC = offR + pad4(n);
  const buf = Buffer.alloc(offC + pad4(n * 3));
  buf.write('HYT2', 0, 'ascii');
  buf.writeUInt32LE(n, 4);
  buf.writeFloatLE(origin.x, 8);
  buf.writeFloatLE(origin.y, 12);
  const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 2)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(q(t.x[i] - origin.x), offX + i * 2);
    buf.writeInt16LE(q(t.y[i] - origin.y), offY + i * 2);
    buf.writeUInt8(Math.min(255, Math.round(t.height[i] * 10)), offH + i);
    buf.writeUInt8(Math.min(255, Math.round(t.radius[i] * 10)), offR + i);
  }
  Buffer.from(t.color.buffer, t.color.byteOffset, n * 3).copy(buf, offC);
  return buf;
}

function bilinear(a, w, h, fi, fj) {
  fi = Math.min(Math.max(fi, 0), w - 1);
  fj = Math.min(Math.max(fj, 0), h - 1);
  const i = Math.min(Math.floor(fi), w - 2);
  const j = Math.min(Math.floor(fj), h - 2);
  const di = fi - i;
  const dj = fj - j;
  return (a[j * w + i] * (1 - di) + a[j * w + i + 1] * di) * (1 - dj) + (a[(j + 1) * w + i] * (1 - di) + a[(j + 1) * w + i + 1] * di) * dj;
}

/** Separable box blur of an interleaved 8-bit image; returns RGB. */
function blurRgb(src, W, H, C, radius) {
  const out = new Uint8Array(W * H * 3);
  if (radius <= 0) {
    for (let k = 0; k < W * H; k++) for (let c = 0; c < 3; c++) out[k * 3 + c] = src[k * C + c];
    return out;
  }
  const n = 2 * radius + 1;
  const tmp = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++)
    for (let c = 0; c < 3; c++) {
      const row = j * W;
      let s = 0;
      for (let t = -radius; t <= radius; t++) s += src[(row + Math.min(W - 1, Math.max(0, t))) * C + c];
      for (let i = 0; i < W; i++) {
        tmp[(row + i) * 3 + c] = s / n;
        s += src[(row + Math.min(W - 1, i + radius + 1)) * C + c] - src[(row + Math.max(0, i - radius)) * C + c];
      }
    }
  for (let i = 0; i < W; i++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let t = -radius; t <= radius; t++) s += tmp[(Math.min(H - 1, Math.max(0, t)) * W + i) * 3 + c];
      for (let j = 0; j < H; j++) {
        out[(j * W + i) * 3 + c] = Math.round(s / n);
        s += tmp[(Math.min(H - 1, j + radius + 1) * W + i) * 3 + c] - tmp[(Math.max(0, j - radius) * W + i) * 3 + c];
      }
    }
  return out;
}

/** OR `bit` into every cell whose centre lies inside the polygon (and the cells of its corners). */
function fillPolygon(mask, G, pts, bit) {
  const { nx, ny, cell, x0, y0 } = G;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((y - y0) / cell);
    if (i >= 0 && j >= 0 && i < nx && j < ny) mask[j * nx + i] |= bit;
  }
  const j0 = Math.max(0, Math.ceil((minY - y0) / cell - 0.5));
  const j1 = Math.min(ny - 1, Math.floor((maxY - y0) / cell - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const yc = y0 + (j + 0.5) * cell;
    xs.length = 0;
    for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
      const ya = pts[a][1];
      const yb = pts[b][1];
      if (ya > yc !== yb > yc) xs.push(pts[a][0] + ((yc - ya) / (yb - ya)) * (pts[b][0] - pts[a][0]));
    }
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - x0) / cell - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[s + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * nx + i] |= bit;
    }
  }
}

/** OR `bit` into every cell whose centre lies within `half` metres of the polyline. */
function stampLine(mask, G, pts, half, bit) {
  const { nx, ny, cell, x0, y0 } = G;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - x0) / cell));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + half - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - half - y0) / cell));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + half - y0) / cell));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * cell - ay;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell - ax;
        const t = Math.min(1, Math.max(0, (px * dx + py * dy) / l2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        if (ex * ex + ey * ey <= half * half) mask[j * nx + i] |= bit;
      }
    }
  }
}

/** 3-4 chamfer distance (in thirds of a cell) to the nearest cell with `bit` set. */
function chamfer(mask, nx, ny, bit) {
  const d = new Uint16Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] & bit ? 0 : 65535;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = d[k];
      if (!v) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + 3);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + 3);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + 4);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + 4);
      }
      d[k] = v;
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = d[k];
      if (!v) continue;
      if (i < nx - 1) v = Math.min(v, d[k + 1] + 3);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + 3);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + 4);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + 4);
      }
      d[k] = v;
    }
  return d;
}
