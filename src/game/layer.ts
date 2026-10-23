import * as THREE from 'three';
import { sampleGrid } from '../engine/cityData';
import type { Engine, EngineLayer } from '../engine/Engine';
import { DotCloud, hexRgb } from './dots';
import { CALL_KINDS, type Call, type GameState, type Plan, type Shelter, type Team } from './rules';
import { nearestNode, type RoadGraph } from './roadGraph';
import { ROLES } from './roles';
import { reachable, type FloodView, type Route, type RouteTree, type Vehicle } from './routing';
import type { GameWorld } from './world';

export interface LayerHandlers {
  /** whether the map currently takes pointer input (a team is planning a move) */
  wantsPointer(): boolean;
  /** pointer over the map: the nearest road node (or null) and the pointer position in px */
  onHover(node: number | null, px: number, py: number): void;
  onClick(node: number | null): void;
  onMarker(kind: string, id: string): void;
}

interface Marker {
  el: HTMLElement;
  x: number;
  y: number;
  gz: number;
  lift: number;
  sig: string;
  shown: boolean;
  prio: number;
  team: number;
}

const BOAT: [number, number, number] = [0.04, 0.65, 0.79];
const RISKY: [number, number, number] = [0.94, 0.55, 0];
const DOT_GAP = 24;
const CUT_GAP = 40;

/** the board game drawn over the city: HTML pins for teams / calls / shelters, dotted routes on the ground */
export class GameLayer implements EngineLayer {
  private root: HTMLDivElement;
  private markers = new Map<string, Marker>();
  private reach = new DotCloud(26000, 40);
  private route = new DotCloud(5000, 50);
  private cut = new DotCloud(30000, 38);
  private v = new THREE.Vector3();
  private w = 1;
  private h = 1;
  private zoom = '';
  private teamPos = new Map<number, { x: number; y: number }>();
  private anim: { team: number; pts: number[]; cum: number[]; dur: number; t: number; done: () => void } | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  private moveQueued = false;
  private lastMove: PointerEvent | null = null;
  private target: { x: number; y: number } | null = null;
  private clock = 0;

  constructor(
    private engine: Engine,
    private world: GameWorld,
    container: HTMLElement,
    private handlers: LayerHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'gm-root';
    container.appendChild(this.root);
    this.engine.scene.add(this.cut.mesh, this.reach.mesh, this.route.mesh);
    this.engine.addLayer(this);
    const dom = this.engine.renderer.domElement;
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointerleave', this.onLeave);
    this.root.addEventListener('click', this.onRootClick);
    this.root.addEventListener('keydown', this.onRootKey);
    this.resize(dom.clientWidth, dom.clientHeight);
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.reach.setResolution(this.w, this.h);
    this.route.setResolution(this.w, this.h);
    this.cut.setResolution(this.w, this.h);
  }

  dispose() {
    const dom = this.engine.renderer.domElement;
    dom.removeEventListener('pointermove', this.onMove);
    dom.removeEventListener('pointerdown', this.onDown);
    dom.removeEventListener('pointerup', this.onUp);
    dom.removeEventListener('pointerleave', this.onLeave);
    this.engine.removeLayer(this);
    this.engine.scene.remove(this.cut.mesh, this.reach.mesh, this.route.mesh);
    this.cut.dispose();
    this.reach.dispose();
    this.route.dispose();
    this.root.remove();
  }

  // ───────────────────────────────────────────── pointer

  private pickNode(e: PointerEvent): number | null {
    const p = this.engine.pickGround(e.clientX, e.clientY);
    if (!p) return null;
    const n = nearestNode(this.world.graph, p.x, p.y, 120);
    return n >= 0 ? n : null;
  }

  private onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    this.lastMove = e;
    if (this.moveQueued) return;
    this.moveQueued = true;
    requestAnimationFrame(() => {
      this.moveQueued = false;
      const ev = this.lastMove;
      if (ev && this.handlers.wantsPointer()) this.handlers.onHover(this.pickNode(ev), ev.clientX, ev.clientY);
    });
  };
  private onLeave = () => this.handlers.onHover(null, 0, 0);
  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && performance.now() - d.t < 600 && this.handlers.wantsPointer()) this.handlers.onClick(this.pickNode(e));
  };
  private onRootClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
    if (el) this.handlers.onMarker(el.dataset.kind!, el.dataset.id!);
  };
  private onRootKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
    if (!el) return;
    e.preventDefault();
    this.handlers.onMarker(el.dataset.kind!, el.dataset.id!);
  };

  // ───────────────────────────────────────────── markers

  private upsert(key: string, kind: string, id: string, x: number, y: number, lift: number, cls: string, html: string, prio: number, label: string, team = -1): void {
    let m = this.markers.get(key);
    if (!m) {
      const el = document.createElement('div');
      el.className = 'gm-mk';
      el.dataset.kind = kind;
      el.dataset.id = id;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.style.display = 'none';
      this.root.appendChild(el);
      m = { el, x, y, gz: sampleGrid(this.world.city.meta, this.world.city.terrain, x, y), lift, sig: '', shown: false, prio, team };
      this.markers.set(key, m);
    }
    const sig = `${cls}|${html}`;
    if (sig !== m.sig) {
      m.sig = sig;
      m.el.innerHTML = `<div class="gm-pin ${cls}">${html}</div>`;
      m.el.setAttribute('aria-label', label);
    }
    if (m.x !== x || m.y !== y) {
      m.x = x;
      m.y = y;
      m.gz = sampleGrid(this.world.city.meta, this.world.city.terrain, x, y);
    }
    m.team = team;
  }

  /** Bring every pin in line with the game state. */
  setState(s: GameState, activeTeam: number | null) {
    const live = new Set<string>();
    const keep = (k: string) => (live.add(k), k);
    for (const sh of s.shelters) {
      const k = keep(`s${sh.id}`);
      this.upsert(k, 'shelter', sh.id, sh.x, sh.y, 14, shelterClass(sh), shelterHtml(sh), 2, `${sh.hospital ? 'โรงพยาบาล' : 'ศูนย์พักพิง'} ${sh.name} ${sh.occupants}/${sh.capacity} คน${sh.closed ? ' ปิดรับ' : ''}`);
    }
    for (const c of s.calls) {
      if (c.status === 'waiting' || (c.status === 'lost' && c.doneRound === s.round)) {
        const k = keep(`c${c.id}`);
        this.upsert(k, 'call', String(c.id), c.x, c.y, 14, callClass(c), callHtml(c), 3, `${c.name} ${c.people} คน ขอความช่วยเหลือ`);
      }
    }
    for (const b of s.blocks) {
      const k = keep(`b${b.id}`);
      this.upsert(k, 'block', String(b.id), b.x, b.y, 10, 'gm-block', `<span class="gm-bface">🚧</span><div class="gm-tip">${b.title}<br>ปิดอีก ${Math.max(0, b.until - s.round + 1)} รอบ</div>`, 2, `ถนนปิด: ${b.title}`);
    }
    for (const t of s.teams) {
      if (!this.anim || this.anim.team !== t.id) this.teamPos.set(t.id, { x: this.world.graph.x[t.node], y: this.world.graph.y[t.node] });
      const pos = this.teamPos.get(t.id)!;
      const k = keep(`t${t.id}`);
      this.upsert(k, 'team', String(t.id), pos.x, pos.y, 16, `gm-team${activeTeam === t.id ? ' active' : ''}${t.stalled ? ' stalled' : ''}`, teamHtml(s, t), 5, `${t.name} ${ROLES[t.role].name}`, t.id);
    }
    if (this.target) {
      const k = keep('target');
      this.upsert(k, 'target', 'target', this.target.x, this.target.y, 6, 'gm-target', '<span class="gm-ring"></span>', 1, 'จุดหมาย — กดเพื่อไป');
    }
    for (const [k, m] of this.markers)
      if (!live.has(k)) {
        m.el.remove();
        this.markers.delete(k);
      }
  }

  /** red dots along district roads the active team cannot use at all right now (neither truck nor boat) */
  setCut(g: RoadGraph, edges: number[], flood: FloodView, v: Vehicle, on: boolean) {
    this.cut.clear();
    if (on) {
      const RED: [number, number, number] = [0.88, 0.19, 0.19];
      for (const e of edges) {
        if (!(flood.blocked?.[e] || (flood.edgeMax[e] > v.truckLimit && (!v.canBoat || flood.edgeMean[e] < v.boatMin * 0.8)))) continue;
        const a = g.geoStart[e];
        const b = g.geoStart[e + 1];
        let rem = 0;
        for (let q = 1; q < b - a; q++) {
          const ax = g.geoXY[2 * (a + q - 1)];
          const ay = g.geoXY[2 * (a + q - 1) + 1];
          const bx = g.geoXY[2 * (a + q)];
          const by = g.geoXY[2 * (a + q) + 1];
          const len = Math.hypot(bx - ax, by - ay);
          let d = rem;
          for (; d < len; d += CUT_GAP) {
            const u = len > 0 ? d / len : 0;
            const x = ax + (bx - ax) * u;
            const y = ay + (by - ay) * u;
            this.cut.push(x, this.ground(x, y) + 2, -y, RED, 0.85, 4);
          }
          rem = d - len;
        }
      }
    }
    this.cut.commit();
  }

  setTarget(node: number | null) {
    this.target = node === null ? null : { x: this.world.graph.x[node], y: this.world.graph.y[node] };
    if (node === null) {
      const m = this.markers.get('target');
      if (m) {
        m.el.remove();
        this.markers.delete('target');
      }
    }
  }

  // ───────────────────────────────────────────── dots

  private ground(x: number, y: number) {
    return sampleGrid(this.world.city.meta, this.world.city.terrain, x, y);
  }

  setReach(g: RoadGraph, tree: RouteTree | null, budget: number, color: string) {
    this.reach.clear();
    if (tree) {
      const c = hexRgb(color);
      for (const r of reachable(g, tree, budget)) {
        const x = g.x[r.node];
        const y = g.y[r.node];
        this.reach.push(x, this.ground(x, y) + 3, -y, r.mode === 1 ? BOAT : c, r.mode === 1 ? 0.6 : 0.45, r.mode === 1 ? 6 : 5);
      }
    }
    this.reach.commit();
  }

  /** dotted route; the part beyond what the team can afford this turn is faded */
  setRoute(g: RoadGraph, plan: Plan | null, color: string) {
    this.route.clear();
    if (plan) {
      const c = hexRgb(color);
      const afford = plan.route.steps.length;
      let idx = 0;
      let rem = 0; // distance still to travel before the next dot, carried over segments and steps
      for (const st of plan.full.steps) {
        const faded = idx++ >= afford;
        if (st.kind !== 'drive') continue;
        const e = st.edge;
        const forward = g.edgeA[e] === st.from;
        const a = g.geoStart[e];
        const b = g.geoStart[e + 1];
        const rgb = st.risk > 0 ? RISKY : st.mode === 1 ? BOAT : c;
        for (let q = 1; q < b - a; q++) {
          const i0 = forward ? a + q - 1 : b - q;
          const i1 = forward ? a + q : b - q - 1;
          const ax = g.geoXY[2 * i0];
          const ay = g.geoXY[2 * i0 + 1];
          const bx = g.geoXY[2 * i1];
          const by = g.geoXY[2 * i1 + 1];
          const len = Math.hypot(bx - ax, by - ay);
          let d = rem;
          for (; d < len; d += DOT_GAP) {
            const u = len > 0 ? d / len : 0;
            const x = ax + (bx - ax) * u;
            const y = ay + (by - ay) * u;
            this.route.push(x, this.ground(x, y) + 4, -y, rgb, faded ? 0.4 : 0.96, faded ? 7 : 9);
          }
          rem = d - len;
        }
      }
    }
    this.route.commit();
  }

  // ───────────────────────────────────────────── movement

  /** Slide a team's pin along a route; resolves when it arrives. */
  animate(teamId: number, g: RoadGraph, route: Route): Promise<void> {
    const pts: number[] = [];
    for (const st of route.steps) {
      if (st.kind !== 'drive') continue;
      const e = st.edge;
      const forward = g.edgeA[e] === st.from;
      const a = g.geoStart[e];
      const b = g.geoStart[e + 1];
      for (let q = 0; q < b - a; q++) {
        const i = forward ? a + q : b - 1 - q;
        pts.push(g.geoXY[2 * i], g.geoXY[2 * i + 1]);
      }
    }
    if (pts.length < 4) return Promise.resolve();
    const cum = [0];
    for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
    const dur = Math.min(4.5, Math.max(0.6, cum[cum.length - 1] / 900));
    return new Promise((resolve) => {
      this.anim = { team: teamId, pts, cum, dur, t: 0, done: resolve };
    });
  }

  setTeamPos(teamId: number, x: number, y: number) {
    this.teamPos.set(teamId, { x, y });
  }

  // ───────────────────────────────────────────── render hooks

  beforeRender(dt: number) {
    this.clock += dt;
    const a = this.anim;
    if (!a) return;
    a.t += dt / a.dur;
    const u = Math.min(1, a.t);
    const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
    const total = a.cum[a.cum.length - 1];
    const want = e * total;
    let k = 1;
    while (k < a.cum.length - 1 && a.cum[k] < want) k++;
    const l = a.cum[k] - a.cum[k - 1] || 1;
    const f = Math.min(1, Math.max(0, (want - a.cum[k - 1]) / l));
    const x = a.pts[2 * k - 2] + (a.pts[2 * k] - a.pts[2 * k - 2]) * f;
    const y = a.pts[2 * k - 1] + (a.pts[2 * k + 1] - a.pts[2 * k - 1]) * f;
    this.teamPos.set(a.team, { x, y });
    const m = this.markers.get(`t${a.team}`);
    if (m) {
      m.x = x;
      m.y = y;
    }
    // the camera glides after the pin
    const gz = this.ground(x, y);
    const dx = (x - this.engine.controls.target.x) * 0.1;
    const dy = (gz - this.engine.controls.target.y) * 0.1;
    const dz = (-y - this.engine.controls.target.z) * 0.1;
    this.engine.controls.target.add(this.v.set(dx, dy, dz));
    this.engine.camera.position.add(this.v);
    if (u >= 1) {
      this.anim = null;
      a.done();
    }
  }

  afterRender() {
    const cam = this.engine.camera;
    const dist = cam.position.distanceTo(this.engine.controls.target);
    const zoom = dist > 7500 ? 'far' : dist > 2600 ? 'mid' : 'near';
    if (zoom !== this.zoom) {
      this.zoom = zoom;
      this.root.dataset.zoom = zoom;
    }
    const v = this.v;
    for (const m of this.markers.values()) {
      if (m.team >= 0) m.gz = this.ground(m.x, m.y);
      v.set(m.x, m.gz + m.lift, -m.y).project(cam);
      const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      if (!vis) {
        if (m.shown) {
          m.el.style.display = 'none';
          m.shown = false;
        }
        continue;
      }
      if (!m.shown) {
        m.el.style.display = '';
        m.shown = true;
      }
      const px = (v.x * 0.5 + 0.5) * this.w;
      const py = (-v.y * 0.5 + 0.5) * this.h;
      m.el.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0)`;
      m.el.style.zIndex = String(m.prio * 10000 + Math.round(py));
    }
  }
}

// ───────────────────────────────────────────── pin contents

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function teamHtml(s: GameState, t: Team): string {
  const role = ROLES[t.role];
  const people = t.load.reduce((n, id) => n + (s.calls.find((c) => c.id === id)?.people ?? 0), 0);
  return `<div class="gm-tface" style="--c:${t.color}">${role.emoji}</div><div class="gm-tmeta" style="--c:${t.color}">${esc(t.name)} ${t.mode === 1 ? '🚤' : '🚙'}${people ? ` 👥${people}` : ''}${t.stalled ? ' 💥' : ''}</div>`;
}

function callClass(c: Call): string {
  const lv = c.status === 'lost' ? 'lost' : c.distress >= 2 ? 3 : c.distress >= 1 ? 2 : c.depth >= 0.15 ? 1 : 0;
  return `gm-call lv${lv}`;
}

function callHtml(c: Call): string {
  const info = CALL_KINDS[c.kind];
  const left = Math.max(0, 3 - Math.floor(c.distress));
  const hearts = c.status === 'lost' ? '💔' : '❤️'.repeat(left) + '🤍'.repeat(3 - left);
  const depth = c.depth >= 0.05 ? `น้ำ ${c.depth.toFixed(1)} ม.` : 'น้ำยังไม่ท่วม';
  return `<div class="gm-cface">${info.emoji}<b>${c.people}</b></div><div class="gm-cmeta"><span class="gm-hearts">${hearts}</span><span class="gm-depth">${depth}</span></div><div class="gm-tip">${esc(c.name)} · ${info.label} ${c.people} คน<br>${depth}</div>`;
}

function shelterClass(sh: Shelter): string {
  return `gm-shelter${sh.closed ? ' closed' : ''}${sh.occupants >= sh.capacity ? ' full' : ''}${sh.hospital ? ' hospital' : ''}`;
}

function shelterHtml(sh: Shelter): string {
  const state = sh.closed ? ' · น้ำท่วม ปิดรับ' : sh.occupants >= sh.capacity ? ' · เต็ม' : '';
  return `<div class="gm-sface">${sh.icon}<small>${sh.occupants}/${sh.capacity}</small></div><div class="gm-sname">${esc(sh.name)}</div><div class="gm-tip">${esc(sh.name)}<br>${sh.hospital ? 'รับเฉพาะผู้ป่วย' : 'ศูนย์พักพิง'} ${sh.occupants}/${sh.capacity} คน${state}</div>`;
}
