/** mulberry32: tiny, fast, seedable PRNG so random scenarios are reproducible from their seed. */
export function createRng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    /** log-normal-ish heavy tail, useful for rainfall intensities */
    heavy: (median: number, spread: number) => median * Math.exp(spread * gauss(next)),
  };
}

function gauss(next: () => number) {
  const u = Math.max(1e-9, next());
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type Rng = ReturnType<typeof createRng>;

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);
