import * as THREE from 'three';
import { sampleGrid, type CityData } from './cityData';
import { ATMOSPHERE, NOISE } from './glsl';
import { SHADOW_GLSL } from './Shadows';

/**
 * OpenStreetMap roads as ribbons draped on the terrain: asphalt with kerbs, centre and lane
 * markings by class, darkened and glossy when wet. Bridges keep a straight deck over canals.
 */
export class Roads {
  readonly mesh: THREE.Mesh;

  constructor(city: CityData, atmosphere: Record<string, THREE.IUniform>, shadow: Record<string, THREE.IUniform>) {
    const { roads: R, meta, terrain } = city;
    const pos: number[] = [];
    const road: number[] = [];
    const idx: number[] = [];
    const ground = (x: number, y: number) => sampleGrid(meta, terrain, x, y);

    for (let r = 0; r < R.count; r++) {
      const n = R.vertCounts[r];
      const o = R.offsets[r] * 2;
      const flags = R.flags[r];
      const cls = flags & 15;
      const bridge = (flags & 16) !== 0;
      const half = R.widths[r] / 2;
      // densify so the ribbon follows the 20 m terrain
      const pts: [number, number][] = [];
      for (let k = 0; k < n; k++) {
        const x = R.coords[o + k * 2];
        const y = R.coords[o + k * 2 + 1];
        if (k > 0) {
          const [px, py] = pts[pts.length - 1];
          const seg = Math.hypot(x - px, y - py);
          const steps = Math.floor(seg / 10);
          for (let s = 1; s < steps; s++) pts.push([px + ((x - px) * s) / steps, py + ((y - py) * s) / steps]);
        }
        pts.push([x, y]);
      }
      if (pts.length < 2) continue;
      // bridges: straight deck between the (higher) ends instead of dipping into the channel
      const zA = ground(pts[0][0], pts[0][1]);
      const zB = ground(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      const lift = 0.18 + (6 - cls) * 0.02;
      let u = 0;
      const base = pos.length / 3;
      for (let k = 0; k < pts.length; k++) {
        const [x, y] = pts[k];
        const [xa, ya] = pts[Math.max(0, k - 1)];
        const [xb, yb] = pts[Math.min(pts.length - 1, k + 1)];
        let dx = xb - xa;
        let dy = yb - ya;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        // miter: widen slightly at bends, capped
        let mx = -dy;
        let my = dx;
        if (k > 0 && k < pts.length - 1) {
          const [x0, y0] = pts[k - 1];
          const l0 = Math.hypot(x - x0, y - y0) || 1;
          const n0x = -(y - y0) / l0;
          const n0y = (x - x0) / l0;
          const dot = n0x * mx + n0y * my;
          const scale = 1 / Math.max(0.6, dot);
          mx *= scale;
          my *= scale;
        }
        if (k > 0) u += Math.hypot(x - pts[k - 1][0], y - pts[k - 1][1]);
        const t = k / (pts.length - 1);
        const z = bridge ? Math.max(zA, zB) * (1 - t) + Math.max(zA, zB) * t + 1.2 : ground(x, y);
        const yL = bridge ? z : Math.max(z, ground(x + mx * half, y + my * half));
        const yR = bridge ? z : Math.max(z, ground(x - mx * half, y - my * half));
        pos.push(x + mx * half, yL + lift, -(y + my * half), x - mx * half, yR + lift, -(y - my * half));
        road.push(u, 1, half * 2, cls, u, -1, half * 2, cls);
      }
      for (let k = 0; k < pts.length - 1; k++) {
        const a = base + k * 2;
        // CCW seen from above (x east, -z north)
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
    geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const mat = new THREE.ShaderMaterial({
      uniforms: { ...atmosphere, ...shadow },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      vertexShader: /* glsl */ `
        attribute vec4 aRoad;
        varying vec4 vRoad;
        varying vec3 vWorld;
        void main() {
          vRoad = aRoad;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${ATMOSPHERE}
        ${NOISE}
        ${SHADOW_GLSL}
        varying vec4 vRoad;
        varying vec3 vWorld;
        void main() {
          float u = vRoad.x;         // metres along the road
          float v = vRoad.y;         // -1 … 1 across
          float width = vRoad.z;
          float cls = vRoad.w;
          float across = abs(v) * width * 0.5; // metres from centre line
          vec3 asphalt = mix(vec3(0.075, 0.078, 0.082), vec3(0.11, 0.11, 0.115), step(4.5, cls));
          asphalt *= 0.92 + 0.16 * vnoise3(vec3(vWorld.xz * 0.6, 1.0));
          vec3 col = asphalt;
          // kerb / shoulder line
          float kerb = smoothstep(width * 0.5 - 0.45, width * 0.5 - 0.25, across);
          col = mix(col, vec3(0.42, 0.42, 0.4), kerb * step(cls, 4.5));
          // markings: dashed centre on main roads, solid double on trunk roads, lane dashes on wide roads
          float camDist = length(cameraPosition - vWorld);
          float markFade = 1.0 - smoothstep(600.0, 1800.0, camDist);
          if (cls < 4.5) {
            float centre = 1.0 - smoothstep(0.08, 0.14, across);
            float dash = step(0.45, fract(u / 9.0));
            vec3 paint = cls < 1.5 ? vec3(0.75, 0.6, 0.15) : vec3(0.72, 0.72, 0.68);
            col = mix(col, paint, centre * (cls < 1.5 ? 1.0 : dash) * markFade);
            if (width > 12.0) {
              float lane = 1.0 - smoothstep(0.06, 0.12, abs(across - width * 0.25));
              col = mix(col, vec3(0.7), lane * step(0.55, fract(u / 7.0)) * markFade);
            }
          }
          vec3 n = vec3(0.0, 1.0, 0.0);
          float wet = smoothstep(0.3, 6.0, uRainNow);
          col *= 1.0 - 0.35 * wet;
          float sh = sunShadow(vWorld + vec3(0.0, 0.3, 0.0), 0.0008);
          vec3 lit = col * (ambientLight(n) + uSunColor * max(uSunDir.y, 0.0) * sh);
          vec3 V = normalize(cameraPosition - vWorld);
          vec3 R = reflect(-V, n);
          float fres = pow(1.0 - max(V.y, 0.0), 5.0);
          lit += (mix(uFogColor, uSkyAmbient, 0.5) * fres * 0.5 + uSunColor * pow(max(dot(R, uSunDir), 0.0), 80.0) * sh * 0.4) * wet;
          // street lights at night
          lit += vec3(1.0, 0.65, 0.3) * 0.05 * (1.0 - uDaylight) * step(cls, 5.5);
          lit = applyFog(lit, camDist, cameraPosition.y - vWorld.y);
          gl_FragColor = vec4(lit, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 1;
  }
}
