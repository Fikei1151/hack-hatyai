import * as THREE from 'three';
import { NOISE } from './glsl';

const RAD = Math.PI / 180;

/** Solar elevation/azimuth (radians) — compact NOAA/Michalsky formulation, good to ~0.1°. */
export function sunPosition(date: Date, lat: number, lon: number) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const h = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const elev = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h));
  const az = Math.atan2(-Math.sin(h), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(h));
  return { elev, az };
}

const c = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const PAL = {
  zenithClear: c(0.2, 0.42, 0.82),
  horizonClear: c(0.66, 0.76, 0.9),
  zenithStorm: c(0.27, 0.3, 0.34),
  horizonStorm: c(0.5, 0.53, 0.56),
  zenithNight: c(0.012, 0.02, 0.045),
  horizonNight: c(0.06, 0.075, 0.11),
};

/**
 * Sun, sky, ambient light and fog driven by the simulation clock and the weather.
 * Owns the shared lighting uniforms consumed by terrain, buildings and water.
 */
export class Atmosphere {
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyAmbient: { value: new THREE.Color(0.5, 0.55, 0.65) },
    uGroundAmbient: { value: new THREE.Color(0.25, 0.24, 0.2) },
    uFogColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
    uFogDensity: { value: 1 / 40000 },
    uStorm: { value: 0 },
    uFlash: { value: 0 },
    uDaylight: { value: 1 },
    uRainNow: { value: 0 },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uTime: { value: 0 },
  };
  readonly sky: THREE.Mesh;
  storm = 0;
  private flashTimer = 0;
  private nextFlash = 3;

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uZenith; uniform vec3 uHorizon;
        uniform float uStorm; uniform float uFlash; uniform float uDaylight; uniform float uTime;
        varying vec3 vDir;
        ${NOISE}
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.55));
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(sd, 900.0) * 6.0 * (1.0 - uStorm) + pow(sd, 8.0) * 0.25 * (1.0 - 0.7 * uStorm));
          // cloud deck
          vec2 uv = d.xz / max(d.y, 0.06) * 0.9;
          float n = fbm3(vec3(uv * 1.4 + vec2(uTime * 0.0004, uTime * 0.0002), uTime * 0.00005));
          float cover = mix(0.62, 0.18, uStorm);
          float cl = smoothstep(cover, cover + 0.25, n) * smoothstep(-0.02, 0.15, d.y);
          vec3 cloudCol = mix(vec3(0.95, 0.96, 0.98), vec3(0.26, 0.28, 0.31), uStorm) * (0.15 + 0.85 * uDaylight);
          cloudCol += uSunColor * pow(sd, 6.0) * 0.3 * (1.0 - uStorm);
          col = mix(col, cloudCol, cl * mix(0.75, 0.97, uStorm));
          col += vec3(0.75, 0.8, 1.0) * uFlash * 1.6 * (0.4 + 0.6 * cl);
          if (d.y < 0.0) col = mix(col, uHorizon * 0.8, smoothstep(0.0, -0.2, d.y));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(80000, 48, 24), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
  }

  /**
   * @param date      simulation wall-clock time
   * @param rainMmHr  current domain-average rain
   * @param realDt    real seconds since last frame (for lightning timing)
   */
  update(date: Date, lat: number, lon: number, rainMmHr: number, realDt: number, forceDay: boolean, simTimeSec: number) {
    const u = this.uniforms;
    const target = Math.min(1, rainMmHr / 18 + (rainMmHr > 0.3 ? 0.35 : 0));
    this.storm += (target - this.storm) * Math.min(1, realDt * 1.5);
    const storm = this.storm;
    u.uStorm.value = storm;
    u.uRainNow.value = rainMmHr;
    u.uTime.value = simTimeSec;

    const { elev, az } = forceDay ? { elev: 62 * RAD, az: 135 * RAD } : sunPosition(date, lat, lon);
    const dir = new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
    u.uSunDir.value.copy(dir);
    const s = Math.sin(elev);
    const day = THREE.MathUtils.smoothstep(s, -0.1, 0.18);
    u.uDaylight.value = day;

    const warm = THREE.MathUtils.smoothstep(s, 0.0, 0.45);
    u.uSunColor.value.setRGB(1.0, 0.6 + 0.36 * warm, 0.38 + 0.52 * warm).multiplyScalar(2.6 * day * (1 - 0.88 * storm));

    const zen = PAL.zenithClear.clone().lerp(PAL.zenithStorm, storm);
    const hor = PAL.horizonClear.clone().lerp(PAL.horizonStorm, storm);
    if (warm < 1) hor.lerp(c(0.95, 0.6, 0.4), (1 - warm) * day * 0.5 * (1 - storm));
    zen.lerp(PAL.zenithNight, 1 - day);
    hor.lerp(PAL.horizonNight, 1 - day);
    u.uZenith.value.copy(zen);
    u.uHorizon.value.copy(hor);

    // night keeps a moonlit/sky-glow floor so the city stays readable around the clock
    u.uSkyAmbient.value.copy(zen).lerp(hor, 0.5).multiplyScalar(0.72 + 0.38 * storm).add(c(0.1, 0.11, 0.16).multiplyScalar(1 - day * 0.7));
    u.uGroundAmbient.value.copy(c(0.3, 0.28, 0.22)).multiplyScalar(0.12 + 0.4 * day * (1 - 0.4 * storm)).add(c(0.05, 0.05, 0.065));
    u.uFogColor.value.copy(hor);
    // visibility: ~40 km clear, ~6 km in very heavy rain
    const vis = THREE.MathUtils.lerp(42000, 5000, Math.min(1, rainMmHr / 60) ** 0.7);
    u.uFogDensity.value = 1 / vis;

    // lightning in thunderstorms
    this.flashTimer += realDt;
    u.uFlash.value *= Math.exp(-realDt * 9);
    if (rainMmHr > 25 && this.flashTimer > this.nextFlash) {
      this.flashTimer = 0;
      this.nextFlash = 1.5 + Math.random() * (rainMmHr > 60 ? 4 : 9);
      u.uFlash.value = 0.6 + Math.random() * 0.6;
      if (Math.random() < 0.5) setTimeout(() => (u.uFlash.value = Math.max(u.uFlash.value, 0.5 + Math.random() * 0.4)), 90 + Math.random() * 120);
    }
  }
}
