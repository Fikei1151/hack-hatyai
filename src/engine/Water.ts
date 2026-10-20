import * as THREE from 'three';
import { gridCentre, gridOrigin, type CityData } from './cityData';
import { ATMOSPHERE, DEPTH_RAMP_GLSL, NOISE } from './glsl';
import { SHADOW_GLSL } from './Shadows';

export type WaterMode = 'realistic' | 'depth' | 'maxdepth';
const MODE_ID: Record<WaterMode, number> = { realistic: 0, depth: 1, maxdepth: 2 };

/**
 * Water surface: one vertex per simulation cell, displaced on the GPU from the solver's state.
 * Dry vertices next to wet ones borrow the neighbouring level so the flat water plane meets the
 * terrain at the true shoreline. The surface texture is advected by the simulated velocity field
 * (flow mapping), so what you see moving is the computed flow — direction and speed.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(
    city: CityData,
    index: THREE.BufferAttribute,
    uv: THREE.BufferAttribute,
    staticTex: THREE.Texture,
    stateUniform: THREE.IUniform,
    fluxUniform: THREE.IUniform,
    atmosphere: Record<string, THREE.IUniform>,
    shadow: Record<string, THREE.IUniform>,
  ) {
    const { meta } = city;
    const { nx, ny, cell } = meta;
    const pos = new Float32Array(nx * ny * 3);
    const g = gridOrigin(meta);
    const x0 = g.x0 + cell / 2;
    const y0 = g.y0 + cell / 2;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = j * nx + i;
        pos[id * 3] = x0 + i * cell;
        pos[id * 3 + 1] = city.terrain[id];
        pos[id * 3 + 2] = -(y0 + j * cell);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', uv);
    geo.setIndex(index);
    const c = gridCentre(meta);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(c.x, meta.elevation.p50, -c.y), Math.hypot(meta.width, meta.height));

    this.uniforms = {
      ...atmosphere,
      ...shadow,
      uState: stateUniform,
      uFlux: fluxUniform,
      uStatic: { value: staticTex },
      uTexel: { value: new THREE.Vector2(1 / nx, 1 / ny) },
      uCell: { value: cell },
      uWetMin: { value: 0.015 },
      uMode: { value: 0 },
      uClock: { value: 0 },
      uMinShow: { value: 0.03 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: true,
      vertexShader: /* glsl */ `
        uniform sampler2D uState;
        uniform sampler2D uFlux;
        uniform sampler2D uStatic;
        uniform vec2 uTexel;
        uniform float uCell;
        uniform float uWetMin;
        uniform int uMode;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vDepth;
        varying float vSpeed;
        varying vec2 vVel;
        varying float vMax;
        varying float vChannel;

        float etaAt(vec2 q, float fallback) {
          vec4 s = texture2D(uState, q);
          return s.r > uWetMin ? texture2D(uStatic, q).r + s.r : fallback;
        }

        void main() {
          vec4 st = texture2D(uState, uv);
          vec4 sta = texture2D(uStatic, uv);
          float z = sta.r;
          float h = uMode == 2 ? st.g : st.r;
          float y;
          float depth = 0.0;
          if (h > uWetMin) {
            y = z + h;
            depth = h;
          } else {
            float best = -1e5;
            for (int dj = -1; dj <= 1; dj++)
              for (int di = -1; di <= 1; di++) {
                if (di == 0 && dj == 0) continue;
                vec2 q = uv + vec2(float(di), float(dj)) * uTexel;
                vec4 sn = texture2D(uState, q);
                float hn = uMode == 2 ? sn.g : sn.r;
                if (hn > uWetMin) best = max(best, texture2D(uStatic, q).r + hn);
              }
            y = best > -1e4 ? (best < z ? best : z - 0.05) : z - 3.0;
          }
          float eta = y;
          float ex = etaAt(uv + vec2(uTexel.x, 0.0), eta) - etaAt(uv - vec2(uTexel.x, 0.0), eta);
          float ey = etaAt(uv + vec2(0.0, uTexel.y), eta) - etaAt(uv - vec2(0.0, uTexel.y), eta);
          vNormal = normalize(vec3(-ex / (2.0 * uCell), 1.0, ey / (2.0 * uCell)));

          // cell-centred velocity from the staggered face fluxes (m/s, x east / y north)
          vec4 f = texture2D(uFlux, uv);
          float qW = texture2D(uFlux, uv - vec2(uTexel.x, 0.0)).r;
          float qS = texture2D(uFlux, uv - vec2(0.0, uTexel.y)).g;
          vec2 vel = 0.5 * vec2(f.r + qW, f.g + qS) / max(st.r, 0.05);
          float sp = length(vel);
          vVel = sp > 4.0 ? vel * (4.0 / sp) : vel;

          vec3 p = vec3(position.x, y, position.z);
          vec4 w = modelMatrix * vec4(p, 1.0);
          vWorld = w.xyz;
          vDepth = depth;
          vSpeed = st.a;
          vMax = st.g;
          vChannel = sta.a;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform int uMode;
        uniform float uClock;
        uniform float uMinShow;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        ${ATMOSPHERE}
        ${NOISE}
        ${SHADOW_GLSL}
        ${DEPTH_RAMP_GLSL}
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vDepth;
        varying float vSpeed;
        varying vec2 vVel;
        varying float vMax;
        varying float vChannel;

        float waveH(vec2 q, float t) {
          return vnoise3(vec3(q, t)) * 0.65 + vnoise3(vec3(q * 2.3 + 7.1, t * 1.3)) * 0.35;
        }
        // flow-mapped wave normal: two noise layers advected along the velocity, cross-faded
        vec3 flowNormal(vec2 p, vec2 vel, float t, float strength) {
          float cyc = 2.4;
          float ph0 = fract(t / cyc);
          float ph1 = fract(t / cyc + 0.5);
          float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
          vec2 q = p * 0.16;
          vec2 a = q - vel * ph0 * cyc * 0.16;
          vec2 b = q + vec2(0.37, 0.71) - vel * ph1 * cyc * 0.16;
          float e = 0.12;
          float slow = t * 0.15;
          float ha = waveH(a, slow);
          float hb = waveH(b, slow);
          vec2 ga = vec2(waveH(a + vec2(e, 0.0), slow) - ha, waveH(a + vec2(0.0, e), slow) - ha) / e;
          vec2 gb = vec2(waveH(b + vec2(e, 0.0), slow) - hb, waveH(b + vec2(0.0, e), slow) - hb) / e;
          vec2 g = ga * w0 + gb * (1.0 - w0);
          return normalize(vec3(-g.x * strength, 1.0, g.y * strength));
        }

        vec2 rainRipple(vec2 p, float t) {
          vec2 g = floor(p / 1.6);
          vec2 acc = vec2(0.0);
          for (int j = -1; j <= 1; j++)
            for (int i = -1; i <= 1; i++) {
              vec2 cellId = g + vec2(float(i), float(j));
              float r = hash12(cellId);
              vec2 c = (cellId + vec2(hash12(cellId + 3.1), hash12(cellId + 7.7))) * 1.6;
              float ph = fract(t * (0.9 + r) + r * 13.0);
              vec2 d = p - c;
              float dist = length(d);
              float ring = sin((dist - ph * 1.2) * 18.0) * smoothstep(0.0, 0.25, ph) * (1.0 - ph) * smoothstep(1.2, 0.0, abs(dist - ph * 1.2) * 4.0);
              acc += normalize(d + 1e-4) * ring;
            }
          return acc;
        }

        void main() {
          float d = vDepth;
          if (d < uMinShow * 0.25) discard;
          vec2 p = vec2(vWorld.x, -vWorld.z);
          vec3 V = normalize(cameraPosition - vWorld);
          float camDist = length(cameraPosition - vWorld);
          float near = 1.0 - smoothstep(500.0, 3500.0, camDist);
          float speed = length(vVel);

          vec3 n = normalize(vNormal);
          // surface ripples carried by the simulated current (stronger and choppier in fast water)
          vec3 fn = flowNormal(p, vVel, uClock, 0.35 + 0.45 * min(speed, 2.0));
          n = normalize(n + vec3(fn.x, 0.0, fn.z) * near);
          if (uRainNow > 0.5) {
            vec2 rr = rainRipple(p, uClock) * min(1.0, uRainNow / 20.0) * (1.0 - smoothstep(60.0, 250.0, camDist));
            n = normalize(n + vec3(rr.x, 0.0, -rr.y) * 0.35);
          }

          vec3 col;
          float alpha;
          bool inBanks = vChannel > 0.5 && vMax - d < 0.6;
          if (uMode == 0) {
            float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
            vec3 R = reflect(-V, n);
            vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.6)) * (1.0 + uFlash * 2.0);
            // muddy flood water vs the darker green-brown water of the canals
            vec3 shallow = vec3(0.32, 0.25, 0.15);
            vec3 deep = vec3(0.12, 0.09, 0.05);
            vec3 body = mix(shallow, deep, smoothstep(0.0, 2.0, d));
            vec3 canal = mix(vec3(0.05, 0.1, 0.085), vec3(0.025, 0.06, 0.05), smoothstep(0.0, 3.0, d));
            if (vChannel > 0.5) body = mix(canal, body, smoothstep(0.3, 1.5, speed) * 0.5);
            // from far away canals read like a map: a clear blue ribbon through the city
            float mapness = smoothstep(1800.0, 7000.0, camDist) * (vChannel > 0.5 ? 1.0 : 0.35);
            body = mix(body, vec3(0.02, 0.17, 0.55), mapness * 0.75);
            float sh = sunShadow(vWorld + vec3(0.0, 0.2, 0.0), 0.0008);
            body *= ambientLight(vec3(0.0, 1.0, 0.0)) * 0.9 + uSunColor * max(uSunDir.y, 0.0) * 0.55 * sh;
            col = mix(body, sky, fres * 0.8 * (1.0 - mapness * 0.6));
            vec3 H = normalize(uSunDir + V);
            col += uSunColor * pow(max(dot(n, H), 0.0), 180.0) * 1.4 * sh;
            // foam: streaks aligned with fast current, a lip on the advancing flood front
            vec2 dir = speed > 0.01 ? vVel / speed : vec2(1.0, 0.0);
            vec2 along = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
            float streak = vnoise3(vec3(along.x * 0.08 - uClock * speed * 0.08, along.y * 0.9, uClock * 0.2));
            float foam = smoothstep(0.55, 0.85, streak) * smoothstep(0.7, 2.2, speed);
            foam += (1.0 - smoothstep(0.02, 0.1, d)) * 0.3 * (1.0 - vChannel);
            // visible current lines: bands drifting downstream at the simulated speed
            float bands = sin(along.x * 0.12 - uClock * speed * 0.9) * 0.5 + 0.5;
            foam += smoothstep(0.9, 1.0, bands) * smoothstep(0.3, 1.2, speed) * 0.25 * (0.4 + 0.6 * vnoise3(vec3(along * 0.05, uClock * 0.1)));
            col = mix(col, vec3(0.62, 0.58, 0.5) * (ambientLight(vec3(0.0, 1.0, 0.0)) + uSunColor * 0.4), clamp(foam, 0.0, 0.85));
            alpha = mix(0.6, 0.95, smoothstep(0.02, 0.5, d)) + fres * 0.05;
            if (inBanks) alpha = max(alpha, 0.9);
          } else {
            col = depthRamp(d) * (0.72 + 0.28 * max(dot(n, normalize(vec3(0.3, 1.0, 0.2))), 0.0));
            col *= 0.55 + 0.45 * uDaylight;
            alpha = 0.9;
          }
          col = applyFog(col, camDist, cameraPosition.y - vWorld.y);
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 2;
  }

  setMode(mode: WaterMode) {
    this.uniforms.uMode.value = MODE_ID[mode];
  }
}
