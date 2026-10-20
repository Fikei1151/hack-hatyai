import * as THREE from 'three';
import { gridOrigin, type CityData } from './cityData';
import { ATMOSPHERE, NOISE, RAIN_FIELD } from './glsl';
import { SHADOW_GLSL } from './Shadows';

/** Shared grid topology for terrain and water: one vertex per simulation cell centre. */
export function gridIndex(nx: number, ny: number): THREE.BufferAttribute {
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // CCW when seen from above (world y up, north = -z)
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = d;
      idx[k++] = c;
    }
  return new THREE.BufferAttribute(idx, 1);
}

export function gridUv(nx: number, ny: number): THREE.BufferAttribute {
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      uv[(j * nx + i) * 2] = (i + 0.5) / nx;
      uv[(j * nx + i) * 2 + 1] = (j + 0.5) / ny;
    }
  return new THREE.BufferAttribute(uv, 2);
}

export interface TerrainUniformSources {
  atmosphere: Record<string, THREE.IUniform>;
  rain: Record<string, THREE.IUniform>;
  shadow: Record<string, THREE.IUniform>;
  water: { uState: THREE.IUniform };
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly skirt: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(city: CityData, index: THREE.BufferAttribute, uv: THREE.BufferAttribute, src: TerrainUniformSources) {
    const { meta, terrain } = city;
    const { nx, ny, cell } = meta;
    const pos = new Float32Array(nx * ny * 3);
    const nor = new Float32Array(nx * ny * 3);
    const g = gridOrigin(meta);
    const x0 = g.x0 + cell / 2;
    const y0 = g.y0 + cell / 2;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = j * nx + i;
        pos[id * 3] = x0 + i * cell;
        pos[id * 3 + 1] = terrain[id];
        pos[id * 3 + 2] = -(y0 + j * cell);
        const zl = terrain[j * nx + Math.max(0, i - 1)];
        const zr = terrain[j * nx + Math.min(nx - 1, i + 1)];
        const zs = terrain[Math.max(0, j - 1) * nx + i];
        const zn = terrain[Math.min(ny - 1, j + 1) * nx + i];
        // world: x east, z south → dz/dz_world = -(dz/dy)
        const n = new THREE.Vector3(-(zr - zl) / (2 * cell), 1, (zn - zs) / (2 * cell)).normalize();
        nor[id * 3] = n.x;
        nor[id * 3 + 1] = n.y;
        nor[id * 3 + 2] = n.z;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', uv);
    geo.setIndex(index);
    geo.computeBoundingSphere();

    const base = loadTex(city.imageryBase);
    const detail = loadTex(city.imageryDetail);
    const lc = new THREE.DataTexture(city.landcover, nx, ny, THREE.RGBAFormat, THREE.UnsignedByteType);
    lc.minFilter = THREE.LinearFilter;
    lc.magFilter = THREE.LinearFilter;
    lc.needsUpdate = true;
    const ib = meta.imagery.base;
    const idt = meta.imagery.detail;

    this.uniforms = {
      ...src.atmosphere,
      ...src.rain,
      ...src.shadow,
      uState: src.water.uState,
      uImgBase: { value: base },
      uImgDetail: { value: detail },
      uLandcover: { value: lc },
      uBaseRect: { value: new THREE.Vector4(ib.x0, ib.y0, ib.x1, ib.y1) },
      uDetailRect: { value: new THREE.Vector4(idt.x0, idt.y0, idt.x1, idt.y1) },
      uShowImagery: { value: 1 },
      uExaggeration: { value: 1 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform float uExaggeration;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          vec3 p = position;
          p.y *= uExaggeration;
          vec4 w = modelMatrix * vec4(p, 1.0);
          vWorld = w.xyz;
          vNormal = normalize(vec3(normal.x * uExaggeration, normal.y, normal.z * uExaggeration));
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uImgBase;
        uniform sampler2D uImgDetail;
        uniform sampler2D uLandcover;
        uniform sampler2D uState;
        uniform vec4 uBaseRect;
        uniform vec4 uDetailRect;
        uniform float uShowImagery;
        ${ATMOSPHERE}
        ${NOISE}
        ${RAIN_FIELD}
        ${SHADOW_GLSL}
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          vec2 p = vec2(vWorld.x, -vWorld.z);
          vec2 ub = (p - uBaseRect.xy) / (uBaseRect.zw - uBaseRect.xy);
          vec2 ud = (p - uDetailRect.xy) / (uDetailRect.zw - uDetailRect.xy);
          vec3 img = texture2D(uImgBase, ub).rgb;
          vec2 edge = min(ud, 1.0 - ud);
          float wd = smoothstep(0.0, 0.04, min(edge.x, edge.y));
          if (wd > 0.0) img = mix(img, texture2D(uImgDetail, ud).rgb, wd);
          vec4 lc = texture2D(uLandcover, vUv);
          vec3 plain = mix(vec3(0.33, 0.4, 0.25), vec3(0.55, 0.52, 0.48), lc.a);
          vec3 albedo = mix(plain, img * 1.08, uShowImagery);

          vec4 st = texture2D(uState, vUv);
          float wet = smoothstep(0.0, 0.03, st.r);
          float mud = smoothstep(0.12, 0.9, st.g) * (1.0 - smoothstep(0.02, 0.2, st.r));
          albedo = mix(albedo, vec3(0.42, 0.35, 0.25), mud * 0.55);
          albedo *= 1.0 - 0.45 * wet;
          albedo *= 1.0 - 0.22 * lc.r;                       // ambient occlusion between buildings
          albedo *= 1.0 - 0.12 * smoothstep(0.5, 8.0, uRainNow); // rain-darkened ground

          vec3 n = normalize(vNormal);
          float shadow = 1.0;
          if (uStorm > 0.02 && uRainNow > 0.05) {
            float cloud = rainShape(p, vWorld.y);
            shadow = 1.0 - 0.75 * smoothstep(0.6, 1.6, cloud) * uStorm;
          }
          float ndl = max(dot(n, uSunDir), 0.0);
          shadow *= sunShadow(vWorld + n * 0.5, 0.0009);
          vec3 col = albedo * (ambientLight(n) + uSunColor * ndl * shadow);
          // street lighting glow in built-up areas after dark
          col += vec3(1.0, 0.62, 0.3) * lc.a * lc.a * (1.0 - uDaylight) * 0.16 * (1.0 - 0.6 * wet);
          float dist = length(vWorld - cameraPosition);
          col = applyFog(col, dist, cameraPosition.y - vWorld.y);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);

    // skirt + outer apron so the 14 km domain does not float in the void
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(220000, 220000).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: { ...src.atmosphere },
        vertexShader: /* glsl */ `varying vec3 vWorld; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vWorld=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
        fragmentShader: /* glsl */ `
          ${ATMOSPHERE}
          varying vec3 vWorld;
          void main(){
            vec3 col = vec3(0.16, 0.21, 0.13) * (ambientLight(vec3(0.0,1.0,0.0)) + uSunColor * max(uSunDir.y, 0.0));
            col = applyFog(col, length(vWorld - cameraPosition), cameraPosition.y - vWorld.y);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    apron.position.y = meta.elevation.min - 8;
    this.skirt = apron;
  }
}

function loadTex(img: HTMLImageElement) {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
