// Network helpers for the city data pipeline: on-disk cache, retries and polite rate limiting.
import fs from 'node:fs/promises';
import path from 'node:path';

export const USER_AGENT = 'hatyai-flood-sim/0.1 (open-source flood simulation prototype)';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cached(file, producer, { refresh = false } = {}) {
  if (!refresh) {
    try {
      return await fs.readFile(file);
    } catch {
      /* cache miss */
    }
  }
  const buf = await producer();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
  return buf;
}

export async function overpass(query, cacheFile, { refresh = false, log = console.log } = {}) {
  const buf = await cached(
    cacheFile,
    async () => {
      let lastErr;
      for (let attempt = 0; attempt < 10; attempt++) {
        const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
            signal: AbortSignal.timeout(300_000),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
          const json = JSON.parse(text);
          if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
          return Buffer.from(text);
        } catch (e) {
          lastErr = e;
          const wait = Math.min(40_000, 3000 * 2 ** Math.floor(attempt / 2));
          log(`    overpass ${new URL(endpoint).host} failed (${e.message}); retry in ${wait / 1000}s`);
          await sleep(wait);
        }
      }
      throw lastErr;
    },
    { refresh },
  );
  return JSON.parse(buf.toString('utf8'));
}

export async function fetchBuffer(url, { retries = 4, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await sleep(800 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Run fn over items with bounded concurrency, preserving order of results. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
