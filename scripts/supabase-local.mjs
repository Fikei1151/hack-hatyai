import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const config = readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
const project = config.match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
if (!project) throw new Error('Missing project_id in supabase/config.toml');
const container = `supabase_db_${project}`;
const network = `${project}-local`;

// Capture CLI output: `supabase start/status` print admin credentials which must not reach logs.
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').split('\n').filter((line) => !/key|secret|password|postgres:\/\//i.test(line)).join('\n').slice(-3000);
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed (exit ${result.status}). ${detail}`);
  }
  return result.stdout;
}

export function localStatus() {
  const status = JSON.parse(run('supabase', ['status', '-o', 'json']));
  const url = new URL(status.API_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('This helper only operates on a local Supabase stack.');
  return status;
}

function checkBindings() {
  const bindings = JSON.parse(run('docker', ['inspect', `supabase_kong_${project}`, '--format', '{{json .NetworkSettings.Ports}}']));
  return Object.values(bindings ?? {}).flat().every((b) => ['127.0.0.1', '::1'].includes(b.HostIp));
}

function start() {
  run('docker', ['info', '--format', '{{.ServerVersion}}']);
  run('supabase', ['--version']);
  const found = spawnSync('docker', ['network', 'inspect', network], { cwd: root, encoding: 'utf8' });
  if (found.status !== 0) {
    run('docker', ['network', 'create', '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', network]);
  } else {
    const info = JSON.parse(found.stdout)[0];
    if (info.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') {
      throw new Error(`Docker network ${network} must bind published ports to 127.0.0.1.`);
    }
  }
  const running = spawnSync('docker', ['inspect', `supabase_kong_${project}`, '--format', '{{json .NetworkSettings.Networks}}'], { cwd: root, encoding: 'utf8' });
  if (running.status === 0 && !Object.hasOwn(JSON.parse(running.stdout), network)) {
    console.log('Backing up and restarting this project on the local Docker network (data is retained).');
    backup();
    run('supabase', ['stop']);
  }
  console.log('Starting Supabase local; the first start may take a few minutes…');
  run('supabase', ['start', '--network-id', network]);
  if (!checkBindings()) console.warn('Docker is publishing the local API on all interfaces despite the loopback network option. See docs/supabase-local.md for Docker Desktop port-binding settings. This stack is for local testing only.');
}

function writeEnv() {
  const status = localStatus();
  const envPath = path.join(root, '.env.local');
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const key = status.PUBLISHABLE_KEY || status.ANON_KEY;
  if (!key) throw new Error('The local stack did not return a public key.');
  for (const [name, value] of Object.entries({ VITE_SUPABASE_URL: status.API_URL, VITE_SUPABASE_ANON_KEY: key })) {
    const line = `${name}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, 'gm');
    text = pattern.test(text) ? text.replace(pattern, () => line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(envPath, text.trimStart(), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log('Updated .env.local with the local API URL and public key (other settings retained).');
}

function migrate() {
  localStatus();
  console.log('Applying pending local migrations without resetting existing data…');
  run('supabase', ['migration', 'up', '--local']);
  const seedDir = path.join(root, 'supabase/seeds');
  for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()) {
    run('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction'], { input: readFileSync(path.join(seedDir, file), 'utf8') });
  }
  run('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-c', "NOTIFY pgrst, 'reload schema';"]);
  console.log('Migrations and reference-place seed applied.');
}

export function backup() {
  localStatus();
  const dir = path.join(root, '.cache/backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `supabase-public-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const partial = `${file}.partial`;
  const fd = openSync(partial, 'wx', 0o600);
  try {
    run('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--format=custom', '--schema=public', '--no-owner', '--no-privileges'], { stdio: ['ignore', fd, 'pipe'] });
    closeSync(fd);
    renameSync(partial, file);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    if (existsSync(partial)) unlinkSync(partial);
    throw error;
  }
  console.log(`Application-table backup: ${path.relative(root, file)}`);
  return file;
}

export async function check() {
  const status = localStatus();
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(status.API_URL, status.PUBLISHABLE_KEY || status.ANON_KEY, { auth: { persistSession: false } });
  const tables = { scenarios: 'id', phases: 'id', simulation_runs: 'id', places: 'id', run_place_impacts: 'run_id', weather_cache: 'key', game_results: 'id' };
  for (const [table, column] of Object.entries(tables)) {
    const { error, count } = await db.from(table).select(column, { count: 'exact', head: true }).abortSignal(AbortSignal.timeout(10000));
    if (error) throw new Error(`${table}: ${error.message}`);
    if (table === 'places' && !count) throw new Error('places is empty; run npm run db:migrate.');
    console.log(`OK ${table}: ${count} rows`);
  }
  console.log(`API: ${status.API_URL}\nStudio: ${status.STUDIO_URL}\nLocal database ready. Shared prototype policies are still enabled; harden them before VPS/public access.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    switch (process.argv[2]) {
      case 'setup': start(); backup(); migrate(); writeEnv(); await check(); break;
      case 'env': writeEnv(); break;
      case 'migrate': backup(); migrate(); await check(); break;
      case 'backup': backup(); break;
      case 'check': await check(); break;
      default: throw new Error('Usage: node scripts/supabase-local.mjs setup|env|migrate|backup|check');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
