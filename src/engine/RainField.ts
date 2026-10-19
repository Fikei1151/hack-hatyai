import * as THREE from 'three';
import { createRng, type Rng } from '../sim/rng';
import type { Forcing, RainPattern } from '../sim/types';
import type { CityMeta } from './cityData';

const PATTERN_ID: Record<RainPattern, number> = { uniform: 0, storm_cells: 1, orographic: 2, squall_line: 3 };
const MAX_CELLS = 16;

interface Cell {
  x: number;
  y: number;
  sigma: number;
  amp: number;
  age: number;
  life: number;
  vx: number;
  vy: number;
}

/**
 * Spatial structure of rainfall: drifting noise, moving convective cells, orographic enhancement
 * and squall lines. The shader evaluates the same shape; this class owns the moving parts and the
 * normalisation that keeps the domain-average intensity equal to the phase's rain_mm_hr.
 */
export class RainField {
  readonly uniforms = {
    uPattern: { value: 0 },
    uRainVar: { value: 0.3 },
    uAdvect: { value: new THREE.Vector2() },
    uCells: { value: Array.from({ length: MAX_CELLS }, () => new THREE.Vector4()) },
    uNumCells: { value: 0 },
    uRainNorm: { value: 1 },
    uZRef: { value: 20 },
    uZRange: { value: 200 },
    uMoveDir: { value: new THREE.Vector2(0, -1) },
    uSquallPos: { value: 0 },
    uFieldTime: { value: 0 },
  };

  private cells: Cell[] = [];
  private rng: Rng;
  private seed: number;
  private phaseKey = '';
  private readonly half: number;
  private readonly elevSamples: Float32Array;

  constructor(
    private meta: CityMeta,
    terrain: Float32Array,
    seed: number,
  ) {
    this.seed = seed;
    this.rng = createRng(seed);
    this.half = Math.max(meta.width, meta.height) / 2;
    // coarse 24×24 elevation sample for orographic normalisation
    this.elevSamples = new Float32Array(24 * 24);
    for (let j = 0; j < 24; j++)
      for (let i = 0; i < 24; i++) {
        const ci = Math.floor(((i + 0.5) / 24) * meta.nx);
        const cj = Math.floor(((j + 0.5) / 24) * meta.ny);
        this.elevSamples[j * 24 + i] = terrain[cj * meta.nx + ci];
      }
    this.uniforms.uZRef.value = meta.elevation.p50;
    this.uniforms.uZRange.value = Math.max(50, meta.elevation.p95 - meta.elevation.p50);
  }

  reset(seed: number) {
    this.seed = seed;
    this.rng = createRng(seed);
    this.cells = [];
    this.phaseKey = '';
    this.uniforms.uAdvect.value.set(0, 0);
    this.uniforms.uFieldTime.value = 0;
  }

  /** Advance moving features by dt seconds of simulation time under the given forcing. */
  update(f: Forcing, simTime: number, dt: number) {
    const u = this.uniforms;
    const rad = (f.windDirDeg * Math.PI) / 180;
    // wind FROM windDir → storms move toward the opposite direction (x east, y north)
    const mx = -Math.sin(rad);
    const my = -Math.cos(rad);
    const speed = Math.max(0.5, f.windSpeedKmh / 3.6);
    u.uMoveDir.value.set(mx, my);
    u.uAdvect.value.x += mx * speed * dt;
    u.uAdvect.value.y += my * speed * dt;
    u.uFieldTime.value = simTime;
    u.uPattern.value = PATTERN_ID[f.pattern];
    u.uRainVar.value = f.variability;

    const key = `${f.phaseIndex}:${f.pattern}`;
    if (key !== this.phaseKey) {
      this.phaseKey = key;
      this.rng = createRng(this.seed * 7919 + f.phaseIndex * 104729);
      this.cells = [];
    }

    if (f.pattern === 'storm_cells') {
      const want = Math.max(1, Math.min(MAX_CELLS, f.stormCells || 4));
      while (this.cells.length < want) this.cells.push(this.spawn(mx, my, speed, this.cells.length === 0 || this.rng.chance(0.6)));
      if (this.cells.length > want) this.cells.length = want;
      for (let k = 0; k < this.cells.length; k++) {
        const c = this.cells[k];
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.age += dt;
        const out = Math.abs(c.x) > this.half + 3 * c.sigma || Math.abs(c.y) > this.half + 3 * c.sigma;
        if (c.age > c.life || out) this.cells[k] = this.spawn(mx, my, speed, false);
      }
      this.cells.forEach((c, k) => {
        const env = Math.sin(Math.PI * Math.min(1, c.age / c.life)) ** 0.6;
        u.uCells.value[k].set(c.x, c.y, c.sigma, c.amp * env);
      });
      u.uNumCells.value = this.cells.length;
    } else {
      u.uNumCells.value = 0;
    }

    if (f.pattern === 'squall_line') {
      const cycle = 2 * this.half + 16000;
      u.uSquallPos.value = ((f.phaseT * speed) % cycle) - this.half - 8000;
    }
    u.uRainNorm.value = 1 / Math.max(0.05, this.meanShape(f.pattern));
  }

  /** Domain mean of the noise-free shape (noise has mean ≈ 1 by construction). */
  private meanShape(pattern: RainPattern): number {
    const u = this.uniforms;
    if (pattern === 'uniform') return 1;
    if (pattern === 'orographic') {
      let s = 0;
      for (const z of this.elevSamples) s += 1 + 1.5 * Math.min(1, Math.max(0, (z - u.uZRef.value) / u.uZRange.value));
      return s / this.elevSamples.length;
    }
    if (pattern === 'squall_line') {
      // average over a full passage so the line, not the background, carries the rain
      const cycle = 2 * this.half + 16000;
      const lineMean = (3 * Math.sqrt(2 * Math.PI) * 1800) / cycle;
      return lineMean + 0.15;
    }
    let s = 0;
    const n = 20;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n - 0.5) * this.meta.width;
        const y = ((j + 0.5) / n - 0.5) * this.meta.height;
        s += this.shapeAt(x, y);
      }
    return s / (n * n);
  }

  /** Noise-free shape at a point (storm cells only); used for normalisation and point readouts. */
  shapeAt(x: number, y: number): number {
    const u = this.uniforms;
    let s = 0;
    for (let k = 0; k < u.uNumCells.value; k++) {
      const c = u.uCells.value[k];
      const dx = x - c.x;
      const dy = y - c.y;
      s += c.w * Math.exp(-(dx * dx + dy * dy) / (2 * c.z * c.z));
    }
    return (1 - u.uRainVar.value) * 0.35 + s;
  }

  private spawn(mx: number, my: number, speed: number, anywhere: boolean): Cell {
    const r = this.rng;
    const sigma = r.range(1400, 3800);
    let x: number;
    let y: number;
    if (anywhere) {
      x = r.range(-this.half, this.half);
      y = r.range(-this.half, this.half);
    } else {
      // enter from the upwind side
      const along = -(this.half + 1.5 * sigma);
      const across = r.range(-this.half, this.half);
      x = mx * along - my * across;
      y = my * along + mx * across;
    }
    const jitter = r.range(-0.35, 0.35);
    const sp = speed * r.range(0.7, 1.3);
    return {
      x,
      y,
      sigma,
      amp: r.heavy(1.0, 0.45),
      age: anywhere ? r.range(0, 3600) : 0,
      life: r.range(1.2, 4.5) * 3600,
      vx: (mx * Math.cos(jitter) - my * Math.sin(jitter)) * sp,
      vy: (my * Math.cos(jitter) + mx * Math.sin(jitter)) * sp,
    };
  }
}
