// Local tangent-plane projection (metres) around a city origin, plus Web-Mercator tile math.
// x = east, y = north. Accurate to well under a metre across a ~15 km domain.

export function makeProjection(lat0, lon0) {
  const phi = (lat0 * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  return {
    lat0,
    lon0,
    mLat,
    mLon,
    toLocal(lat, lon) {
      return [(lon - lon0) * mLon, (lat - lat0) * mLat];
    },
    toLatLon(x, y) {
      return [lat0 + y / mLat, lon0 + x / mLon];
    },
  };
}

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Deterministic hash → [0,1) so estimated building heights are stable between builds. */
export function hash01(n) {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a) / 2;
}

export function polygonCentroid(pts) {
  let x = 0,
    y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}
