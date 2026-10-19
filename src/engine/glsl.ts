// Shared GLSL chunks. The rain field is evaluated identically in the solver (as a source term)
// and in the render shaders (cloud shadows, rain ripples), so storms you see are storms that fall.

export const NOISE = /* glsl */ `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float fbm3(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise3(p);
    p = p * 2.03 + vec3(17.1, 9.2, 3.7);
    a *= 0.5;
  }
  return s / 0.9375;
}
`;

/** Uniform block + function for the spatial rain multiplier. Mirrors RainField.ts. */
export const RAIN_FIELD = /* glsl */ `
uniform int uPattern;
uniform float uRainVar;
uniform vec2 uAdvect;
uniform vec4 uCells[16];
uniform int uNumCells;
uniform float uRainNorm;
uniform float uZRef;
uniform float uZRange;
uniform vec2 uMoveDir;
uniform float uSquallPos;
uniform float uFieldTime;

float rainShape(vec2 p, float z) {
  float n = fbm3(vec3((p - uAdvect) / 4500.0, uFieldTime / 5400.0));
  float noiseTerm = 1.0 + uRainVar * 1.6 * (n - 0.5) * 2.0;
  float f;
  if (uPattern == 1) {
    float s = 0.0;
    for (int k = 0; k < 16; k++) {
      if (k >= uNumCells) break;
      vec4 c = uCells[k];
      vec2 d = p - c.xy;
      s += c.w * exp(-dot(d, d) / (2.0 * c.z * c.z));
    }
    f = ((1.0 - uRainVar) * 0.35 + s) * mix(1.0, noiseTerm, 0.5);
  } else if (uPattern == 2) {
    f = (1.0 + 1.5 * clamp((z - uZRef) / uZRange, 0.0, 1.0)) * noiseTerm;
  } else if (uPattern == 3) {
    float along = dot(p, uMoveDir) - uSquallPos;
    f = (exp(-along * along / (2.0 * 1800.0 * 1800.0)) * 3.0 + 0.15) * mix(1.0, noiseTerm, 0.6);
  } else {
    f = noiseTerm;
  }
  return max(f, 0.0);
}
float rainFactor(vec2 p, float z) { return rainShape(p, z) * uRainNorm; }
`;

/** Lighting/fog uniforms shared by every lit material. */
export const ATMOSPHERE = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uStorm;
uniform float uFlash;
uniform float uDaylight;
uniform float uRainNow;

vec3 applyFog(vec3 col, float dist, float heightAboveGround) {
  float f = 1.0 - exp(-pow(dist * uFogDensity, 1.35));
  f *= mix(1.0, 0.75, clamp(heightAboveGround / 2500.0, 0.0, 1.0));
  return mix(col, uFogColor, clamp(f, 0.0, 1.0));
}
vec3 ambientLight(vec3 n) {
  return mix(uGroundAmbient, uSkyAmbient, n.y * 0.5 + 0.5) * (1.0 + uFlash * 2.5);
}
`;

/**
 * Flood-depth encoding (sequential, one hue, light → dark). Shared by the water/building shaders
 * and the on-screen legend so the colours on the map and in the key always agree.
 */
export const DEPTH_RAMP: { depth: number; hex: string; label: string }[] = [
  { depth: 0, hex: '#cde2fb', label: '0' },
  { depth: 0.3, hex: '#9ec5f4', label: '0.3' },
  { depth: 0.5, hex: '#6da7ec', label: '0.5' },
  { depth: 1.0, hex: '#3987e5', label: '1' },
  { depth: 1.5, hex: '#256abf', label: '1.5' },
  { depth: 2.0, hex: '#184f95', label: '2' },
  { depth: 3.0, hex: '#0d366b', label: '3+ ม.' },
];

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function glslLinear(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255).toFixed(4));
  return `vec3(${ch.join(', ')})`;
}

/** GLSL function `vec3 depthRamp(float d)` returning a linear-space colour. */
export const DEPTH_RAMP_GLSL = /* glsl */ `
vec3 depthRamp(float d) {
  ${DEPTH_RAMP.slice(1)
    .map((s, i) => {
      const a = DEPTH_RAMP[i];
      return `if (d < ${s.depth.toFixed(2)}) return mix(${glslLinear(a.hex)}, ${glslLinear(s.hex)}, (d - ${a.depth.toFixed(2)}) / ${(s.depth - a.depth).toFixed(2)});`;
    })
    .join('\n  ')}
  return ${glslLinear(DEPTH_RAMP[DEPTH_RAMP.length - 1].hex)};
}
`;
