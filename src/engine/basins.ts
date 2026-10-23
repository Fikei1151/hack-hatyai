/**
 * Depth of every closed depression in a grid DEM (priority-flood, Barnes et al. 2014): how much water
 * the ground holds in that cell before it spills over the rim. The city build fills shallow DEM noise
 * pits but keeps deeper basins (paddies, retention areas, old ponds) as real storage.
 */
export function depressionDepth(z: Float32Array, nx: number, ny: number): Float32Array {
  const n = nx * ny;
  const fill = Float32Array.from(z);
  const done = new Uint8Array(n);
  const heapId = new Int32Array(n);
  const heapZ = new Float32Array(n);
  let size = 0;

  const push = (id: number, v: number) => {
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapZ[p] <= v) break;
      heapId[i] = heapId[p];
      heapZ[i] = heapZ[p];
      i = p;
    }
    heapId[i] = id;
    heapZ[i] = v;
  };
  const pop = () => {
    const top = heapId[0];
    const lastId = heapId[--size];
    const lastZ = heapZ[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && heapZ[c + 1] < heapZ[c]) c++;
      if (heapZ[c] >= lastZ) break;
      heapId[i] = heapId[c];
      heapZ[i] = heapZ[c];
      i = c;
    }
    heapId[i] = lastId;
    heapZ[i] = lastZ;
    return top;
  };
  const seed = (id: number) => {
    if (done[id]) return;
    done[id] = 1;
    push(id, fill[id]);
  };

  // every edge of the domain drains (outflow edges and the lake)
  for (let i = 0; i < nx; i++) {
    seed(i);
    seed((ny - 1) * nx + i);
  }
  for (let j = 1; j < ny - 1; j++) {
    seed(j * nx);
    seed(j * nx + nx - 1);
  }
  while (size) {
    const c = pop();
    const ci = c % nx;
    const cj = (c - ci) / nx;
    for (let k = 0; k < 4; k++) {
      const i = ci + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const j = cj + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const nb = j * nx + i;
      if (done[nb]) continue;
      done[nb] = 1;
      if (fill[nb] < fill[c]) fill[nb] = fill[c];
      push(nb, fill[nb]);
    }
  }
  for (let id = 0; id < n; id++) fill[id] -= z[id];
  return fill;
}
