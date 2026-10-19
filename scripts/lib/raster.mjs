// Raster utilities for the city grid. Grids are row-major Float32Array/Uint8Array,
// row 0 = southernmost row, column 0 = westernmost column (matches WebGL texture v=0 at south).

export class Grid {
  constructor(nx, ny, cell, x0, y0) {
    this.nx = nx;
    this.ny = ny;
    this.cell = cell;
    this.x0 = x0; // local x of the west edge
    this.y0 = y0; // local y of the south edge
    this.size = nx * ny;
  }
  center(i, j) {
    return [this.x0 + (i + 0.5) * this.cell, this.y0 + (j + 0.5) * this.cell];
  }
  /** fractional cell-centre index for a local coordinate */
  frac(x, y) {
    return [(x - this.x0) / this.cell - 0.5, (y - this.y0) / this.cell - 0.5];
  }
  contains(x, y, margin = 0) {
    return (
      x >= this.x0 + margin &&
      y >= this.y0 + margin &&
      x <= this.x0 + this.nx * this.cell - margin &&
      y <= this.y0 + this.ny * this.cell - margin
    );
  }
}

export function sampleBilinear(arr, nx, ny, fi, fj) {
  fi = Math.min(Math.max(fi, 0), nx - 1);
  fj = Math.min(Math.max(fj, 0), ny - 1);
  const i = Math.min(Math.floor(fi), nx - 2);
  const j = Math.min(Math.floor(fj), ny - 2);
  const di = fi - i;
  const dj = fj - j;
  const a = arr[j * nx + i];
  const b = arr[j * nx + i + 1];
  const c = arr[(j + 1) * nx + i];
  const d = arr[(j + 1) * nx + i + 1];
  return (a * (1 - di) + b * di) * (1 - dj) + (c * (1 - di) + d * di) * dj;
}

function kernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

export function gaussianBlur(src, nx, ny, sigma) {
  if (sigma <= 0) return Float32Array.from(src);
  const { k, r } = kernel(sigma);
  const tmp = new Float32Array(nx * ny);
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += src[j * nx + Math.min(nx - 1, Math.max(0, i + t))] * k[t + r];
      tmp[j * nx + i] = s;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += tmp[Math.min(ny - 1, Math.max(0, j + t)) * nx + i] * k[t + r];
      out[j * nx + i] = s;
    }
  return out;
}

function rankFilter(src, nx, ny, r, pick) {
  const tmp = new Float32Array(nx * ny);
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = src[j * nx + i];
      for (let t = Math.max(0, i - r); t <= Math.min(nx - 1, i + r); t++) v = pick(v, src[j * nx + t]);
      tmp[j * nx + i] = v;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = tmp[j * nx + i];
      for (let t = Math.max(0, j - r); t <= Math.min(ny - 1, j + r); t++) v = pick(v, tmp[t * nx + i]);
      out[j * nx + i] = v;
    }
  return out;
}

export const minFilter = (src, nx, ny, r) => rankFilter(src, nx, ny, r, Math.min);
export const maxFilter = (src, nx, ny, r) => rankFilter(src, nx, ny, r, Math.max);

/** Morphological opening: removes positive bumps (buildings, tree clumps) narrower than the window. */
export const opening = (src, nx, ny, r) => maxFilter(minFilter(src, nx, ny, r), nx, ny, r);

/**
 * Accumulate polygon coverage (0..1 per cell) using an S×S sub-sample scanline.
 * polygons: array of [[x,y],...] in local metres.
 */
export function polygonCoverage(polygons, grid, S = 4, weights = null) {
  const { nx, ny, cell, x0, y0 } = grid;
  const counts = new Float32Array(nx * ny);
  const inv = S / cell;
  const subNx = nx * S;
  const subNy = ny * S;
  const xs = [];
  for (let pi = 0; pi < polygons.length; pi++) {
    const poly = polygons[pi];
    const wgt = weights ? weights[pi] : 1;
    const n = poly.length;
    if (n < 3) continue;
    let minY = Infinity,
      maxY = -Infinity;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      px[k] = (poly[k][0] - x0) * inv;
      py[k] = (poly[k][1] - y0) * inv;
      if (py[k] < minY) minY = py[k];
      if (py[k] > maxY) maxY = py[k];
    }
    const r0 = Math.max(0, Math.floor(minY));
    const r1 = Math.min(subNy - 1, Math.ceil(maxY));
    for (let r = r0; r <= r1; r++) {
      const yc = r + 0.5;
      xs.length = 0;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ya = py[a],
          yb = py[b];
        if (ya > yc !== yb > yc) xs.push(px[a] + ((yc - ya) / (yb - ya)) * (px[b] - px[a]));
      }
      xs.sort((p, q) => p - q);
      const cj = Math.floor(r / S);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const c0 = Math.max(0, Math.ceil(xs[s] - 0.5));
        const c1 = Math.min(subNx - 1, Math.floor(xs[s + 1] - 0.5));
        if (c1 < c0) continue;
        for (let ci = Math.floor(c0 / S); ci <= Math.floor(c1 / S); ci++) {
          const lo = Math.max(c0, ci * S);
          const hi = Math.min(c1, ci * S + S - 1);
          counts[cj * nx + ci] += (hi - lo + 1) * wgt;
        }
      }
    }
  }
  for (let i = 0; i < counts.length; i++) counts[i] = weights ? counts[i] / (S * S) : Math.min(1, counts[i] / (S * S));
  return counts;
}

/** Resample a polyline so consecutive points are at most `step` metres apart. */
export function densify(pts, step) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= n; s++) out.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
  }
  return out;
}

/**
 * Bank-level profile along a channel given in flow order: running minimum of the smoothed DEM
 * (removes bridges and DSM noise so water can always run downstream). `cap` continues the
 * profile from an upstream reach so split OSM ways join without artificial sills.
 */
export function channelProfile(grid, pts, zSmooth, cap = Infinity) {
  const { nx, ny, cell } = grid;
  const line = densify(pts, cell / 2);
  const bank = new Float32Array(line.length);
  let run = cap;
  for (let k = 0; k < line.length; k++) {
    const [fi, fj] = grid.frac(line[k][0], line[k][1]);
    run = Math.min(run, sampleBilinear(zSmooth, nx, ny, fi, fj));
    bank[k] = run;
  }
  return { line, bank };
}

/** Burn a channel (bed = bank − depth) with linear side slopes of `bankWidth` metres. */
export function burnChannel(z, mask, grid, { line, bank }, { width, depth, bankWidth, kind = 0, kindMask = null }) {
  const { nx, ny } = grid;
  const halfW = width / 2;
  const reach = halfW + bankWidth;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k];
    const [bx, by] = line[k + 1];
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const [fi0, fj0] = grid.frac(Math.min(ax, bx) - reach, Math.min(ay, by) - reach);
    const [fi1, fj1] = grid.frac(Math.max(ax, bx) + reach, Math.max(ay, by) + reach);
    for (let j = Math.max(0, Math.floor(fj0)); j <= Math.min(ny - 1, Math.ceil(fj1)); j++)
      for (let i = Math.max(0, Math.floor(fi0)); i <= Math.min(nx - 1, Math.ceil(fi1)); i++) {
        const [cx, cy] = grid.center(i, j);
        const t = Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / len2));
        const d = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
        if (d > reach) continue;
        const id = j * nx + i;
        const b = bank[k] + (bank[k + 1] - bank[k]) * t - depth;
        let target;
        if (d <= halfW) {
          target = b;
          mask[id] = 255;
          if (kindMask) kindMask[id] = kind;
        } else {
          target = b + (z[id] - b) * ((d - halfW) / bankWidth);
        }
        if (target < z[id]) z[id] = target;
      }
  }
}

/**
 * Priority-Flood depression filling (Barnes et al. 2014) seeded from the domain edges.
 * Returns the filled surface; callers cap the fill depth so real basins survive while DEM noise
 * pits (which would otherwise trap rain as speckled puddles) are removed.
 */
export function priorityFlood(z, nx, ny) {
  const out = Float32Array.from(z);
  const done = new Uint8Array(nx * ny);
  const heap = new MinHeap(nx * 4 + ny * 4);
  const push = (id) => {
    done[id] = 1;
    heap.push(id, out[id]);
  };
  for (let i = 0; i < nx; i++) {
    push(i);
    push((ny - 1) * nx + i);
  }
  for (let j = 1; j < ny - 1; j++) {
    push(j * nx);
    push(j * nx + nx - 1);
  }
  while (heap.size) {
    const c = heap.pop();
    const ci = c % nx;
    const cj = (c - ci) / nx;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const n = j * nx + i;
      if (done[n]) continue;
      if (out[n] < out[c]) out[n] = out[c];
      push(n);
    }
  }
  return out;
}

class MinHeap {
  constructor(cap) {
    this.ids = new Int32Array(cap);
    this.keys = new Float32Array(cap);
    this.size = 0;
  }
  push(id, key) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2);
      ids.set(this.ids);
      const keys = new Float32Array(this.keys.length * 2);
      keys.set(this.keys);
      this.ids = ids;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }
  pop() {
    const top = this.ids[0];
    const lastId = this.ids[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastKey) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = lastId;
    this.keys[i] = lastKey;
    return top;
  }
}
