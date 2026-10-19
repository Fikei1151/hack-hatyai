import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { sampleGrid, type CityData, type Place, type PlaceCategory } from './cityData';

export interface LabelHandlers {
  onPoiClick: (id: string) => void;
  onPlaceClick: (id: string) => void;
}

export interface LabelVisibility {
  landmarks: boolean;
  localities: boolean;
  canals: boolean;
  roads: boolean;
  places: boolean;
  placeCategories: Set<PlaceCategory>;
}

export const PLACE_ICON: Record<PlaceCategory, string> = {
  health: '✚',
  education: '✎',
  religion: '☸',
  market: '◆',
  emergency: '✱',
  government: '▣',
  transport: '◉',
  lodging: '⌂',
  landmark: '★',
  shelter: '⛑',
};

const KIND_ICON: Record<string, string> = { mosque: '☪', church: '✝', shrine: '⛩' };

interface Candidate {
  obj: CSS2DObject;
  el: HTMLElement;
  priority: number;
}

interface PlaceLabel {
  place: Place;
  obj: CSS2DObject;
  el: HTMLElement;
  depthEl: HTMLElement;
  world: THREE.Vector3;
}

/** HTML labels anchored in 3D: landmarks, places, canals, roads, inflow points, localities. */
export class Labels {
  readonly renderer: CSS2DRenderer;
  readonly group = new THREE.Group();
  private poiEls = new Map<string, { root: HTMLElement; depth: HTMLElement }>();
  private inflowEls = new Map<string, HTMLElement>();
  private placeLabels: PlaceLabel[] = [];
  private byKind: Record<'landmark' | 'locality' | 'canal' | 'road' | 'inflow', CSS2DObject[]> = { landmark: [], locality: [], canal: [], road: [], inflow: [] };
  private ground: (x: number, y: number) => number;
  private sizes = new WeakMap<HTMLElement, [number, number]>();
  private priority = new WeakMap<CSS2DObject, number>();
  private v = new THREE.Vector3();

  constructor(
    container: HTMLElement,
    city: CityData,
    private handlers: LabelHandlers,
  ) {
    this.renderer = new CSS2DRenderer();
    this.renderer.domElement.className = 'labels-layer';
    container.appendChild(this.renderer.domElement);
    this.ground = (x, y) => sampleGrid(city.meta, city.terrain, x, y);

    for (const p of city.meta.pois) {
      const root = document.createElement('button');
      root.className = 'poi-label';
      root.type = 'button';
      root.innerHTML = `<span class="poi-pin" aria-hidden="true"></span><span class="poi-text"><span class="poi-name"></span><span class="poi-depth"></span></span>`;
      (root.querySelector('.poi-name') as HTMLElement).textContent = p.name;
      root.title = `${p.name} · ${p.en}`;
      root.addEventListener('click', () => handlers.onPoiClick(p.id));
      const obj = this.add(root, p.x, p.y, 28, [0, 1]);
      this.priority.set(obj, 100);
      this.byKind.landmark.push(obj);
      this.poiEls.set(p.id, { root, depth: root.querySelector('.poi-depth') as HTMLElement });
    }

    for (const f of city.meta.inflows) {
      const el = document.createElement('div');
      el.className = 'inflow-label';
      el.innerHTML = `<span class="inflow-arrow" aria-hidden="true">⬆</span><span><b></b><small></small></span>`;
      (el.querySelector('b') as HTMLElement).textContent = `น้ำไหลเข้า: ${f.name}`;
      const io = this.add(el, f.x, f.y, 40, [0.5, 1]);
      this.priority.set(io, 95);
      this.byKind.inflow.push(io);
      this.inflowEls.set(f.id, el);
    }

    for (const pl of city.meta.places) {
      const el = document.createElement('div');
      el.className = `place-label place-${pl.kind}`;
      el.textContent = pl.name;
      const lo = this.add(el, pl.x, pl.y, 60, [0.5, 0.5]);
      this.priority.set(lo, 8);
      this.byKind.locality.push(lo);
    }

    // canal names: one label per named canal (two on long ones), placed on the in-domain stretch
    const canals = new Map<string, [number, number][]>();
    for (const w of city.waterways) {
      if (!w.name || !/คลอง|Klong|Khlong/i.test(w.name)) continue;
      const inside = w.pts.filter(([x, y]) => Math.abs(x) < city.meta.width / 2 - 150 && Math.abs(y) < city.meta.height / 2 - 150);
      if (inside.length < 2) continue;
      const key = w.name.replace('อุ่ตะเภา', 'อู่ตะเภา');
      const cur = canals.get(key);
      if (!cur || pathLength(cur) < pathLength(inside)) canals.set(key, inside);
    }
    for (const [name, pts] of canals) {
      const len = pathLength(pts);
      for (const f of len > 6000 ? [0.3, 0.72] : [0.5]) {
        const [x, y] = pointAlong(pts, f);
        const el = document.createElement('div');
        el.className = 'canal-label';
        el.textContent = name;
        const co = this.add(el, x, y, 12, [0.5, 0.5]);
        this.priority.set(co, 85);
        this.byKind.canal.push(co);
      }
    }

    for (const r of city.roadLabels) {
      const el = document.createElement('div');
      el.className = `road-label road-${r.cls <= 2 ? 'major' : 'minor'}`;
      el.textContent = r.name;
      const ro = this.add(el, r.x, r.y, 6, [0.5, 0.5]);
      this.priority.set(ro, r.cls <= 2 ? 30 : 18);
      this.byKind.road.push(ro);
    }

    this.setPlaces(city.places);
  }

  private add(el: HTMLElement, x: number, y: number, lift: number, center: [number, number]) {
    const obj = new CSS2DObject(el);
    obj.position.set(x, this.ground(x, y) + lift, -y);
    obj.center.set(center[0], center[1]);
    this.group.add(obj);
    return obj;
  }

  /** Replace the important-place markers (e.g. after loading them from Supabase). */
  setPlaces(places: Place[]) {
    for (const l of this.placeLabels) this.group.remove(l.obj);
    this.placeLabels = places.map((place) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `kp-label kp-${place.category}`;
      el.dataset.importance = String(place.importance);
      el.innerHTML = `<span class="kp-icon" aria-hidden="true"></span><span class="kp-name"></span><span class="kp-depth"></span>`;
      (el.querySelector('.kp-icon') as HTMLElement).textContent = KIND_ICON[place.kind] ?? PLACE_ICON[place.category];
      (el.querySelector('.kp-name') as HTMLElement).textContent = place.name;
      el.title = place.name_en ? `${place.name} · ${place.name_en}` : place.name;
      el.addEventListener('click', () => this.handlers.onPlaceClick(place.id));
      const obj = this.add(el, place.x, place.y, 14, [0.5, 1]);
      return { place, obj, el, depthEl: el.querySelector('.kp-depth') as HTMLElement, world: obj.position.clone() };
    });
  }

  setPlaceDepths(depths: Float32Array) {
    this.placeLabels.forEach((l, i) => {
      const d = depths[i] ?? 0;
      const level = d >= 1 ? 'critical' : d >= 0.5 ? 'serious' : d >= 0.1 ? 'warning' : 'good';
      if (l.el.dataset.level !== level) l.el.dataset.level = level;
      const txt = d >= 0.1 ? `${d.toFixed(1)} ม.` : '';
      if (l.depthEl.textContent !== txt) l.depthEl.textContent = txt;
    });
  }

  setPoiDepth(id: string, depth: number, maxDepth: number) {
    const e = this.poiEls.get(id);
    if (!e) return;
    const level = depth >= 1 ? 'critical' : depth >= 0.5 ? 'serious' : depth >= 0.1 ? 'warning' : 'good';
    e.root.dataset.level = level;
    e.depth.textContent = depth >= 0.05 ? `น้ำ ${depth.toFixed(2)} ม.` : maxDepth >= 0.1 ? `แห้ง (สูงสุด ${maxDepth.toFixed(1)} ม.)` : 'แห้ง';
  }

  setInflow(id: string, m3s: number) {
    const el = this.inflowEls.get(id);
    if (el) (el.querySelector('small') as HTMLElement).textContent = `${Math.round(m3s).toLocaleString('th-TH')} ลบ.ม./วินาที`;
  }

  /** Visibility per label kind, decluttered by camera distance so the city stays readable. */
  update(camera: THREE.Camera, target: THREE.Vector3, vis: LabelVisibility) {
    const camDist = camera.position.distanceTo(target);
    for (const o of this.byKind.landmark) o.visible = vis.landmarks;
    for (const o of this.byKind.inflow) o.visible = vis.landmarks;
    for (const o of this.byKind.locality) o.visible = vis.localities;
    for (const o of this.byKind.canal) o.visible = vis.canals && camDist < 14000;
    for (const o of this.byKind.road) o.visible = vis.roads && camDist < 4500 && o.position.distanceTo(target) < camDist * 1.4;
    for (const l of this.placeLabels) {
      if (!vis.places || !vis.placeCategories.has(l.place.category)) {
        l.obj.visible = false;
        continue;
      }
      const dist = l.world.distanceTo(target);
      const wet = l.el.dataset.level && l.el.dataset.level !== 'good';
      // important or flooded places stay visible further out
      const reach = (l.place.importance >= 8 ? 2.2 : l.place.importance >= 6 ? 1.2 : 0.7) * Math.max(900, camDist) * (wet ? 1.6 : 1);
      l.obj.visible = dist < reach;
      const level = l.el.dataset.level;
      this.priority.set(l.obj, l.place.importance * 5 + (level === 'critical' ? 45 : level === 'serious' ? 35 : level === 'warning' ? 25 : 0));
    }
    this.declutter(camera);
  }

  /** Greedy screen-space declutter: higher-priority labels win, overlapping ones are hidden. */
  private declutter(camera: THREE.Camera) {
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    if (!w || !h) return;
    const cand: Candidate[] = [];
    for (const child of this.group.children) {
      const obj = child as CSS2DObject;
      if (!obj.visible) continue;
      cand.push({ obj, el: obj.element, priority: this.priority.get(obj) ?? 10 });
    }
    cand.sort((a, b) => b.priority - a.priority);
    const cell = 80;
    const grid = new Map<number, [number, number, number, number][]>();
    const pad = 3;
    for (const c of cand) {
      this.v.copy(c.obj.position).project(camera);
      if (this.v.z > 1 || this.v.x < -1.2 || this.v.x > 1.2 || this.v.y < -1.2 || this.v.y > 1.2) {
        c.obj.visible = false;
        continue;
      }
      let size = this.sizes.get(c.el);
      if (!size || size[0] === 0) {
        const ow = c.el.offsetWidth;
        size = ow ? [ow, c.el.offsetHeight] : [110, 22];
        if (ow) this.sizes.set(c.el, size);
      }
      const sx = (this.v.x * 0.5 + 0.5) * w - size[0] * c.obj.center.x;
      const sy = (-this.v.y * 0.5 + 0.5) * h - size[1] * c.obj.center.y;
      const r: [number, number, number, number] = [sx - pad, sy - pad, sx + size[0] + pad, sy + size[1] + pad];
      const gx0 = Math.floor(r[0] / cell);
      const gx1 = Math.floor(r[2] / cell);
      const gy0 = Math.floor(r[1] / cell);
      const gy1 = Math.floor(r[3] / cell);
      let hit = false;
      for (let gy = gy0; gy <= gy1 && !hit; gy++)
        for (let gx = gx0; gx <= gx1 && !hit; gx++)
          for (const o of grid.get(gy * 4096 + gx) ?? []) if (r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]) hit = true;
      if (hit) {
        c.obj.visible = false;
        continue;
      }
      for (let gy = gy0; gy <= gy1; gy++)
        for (let gx = gx0; gx <= gx1; gx++) {
          const k = gy * 4096 + gx;
          const list = grid.get(k);
          if (list) list.push(r);
          else grid.set(k, [r]);
        }
    }
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer.render(scene, camera);
  }
}

function pathLength(pts: [number, number][]) {
  let l = 0;
  for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return l;
}

function pointAlong(pts: [number, number][], f: number): [number, number] {
  const total = pathLength(pts);
  let acc = 0;
  for (let k = 1; k < pts.length; k++) {
    const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (acc + l >= total * f) {
      const u = (total * f - acc) / (l || 1);
      return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * u, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * u];
    }
    acc += l;
  }
  return pts[pts.length - 1];
}
