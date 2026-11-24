#!/usr/bin/env node
// Stand-in for `psql` on the server (there is no psql binary there, only the
// embedded Postgres of the trial copy). Covers what local/checks/*.py use:
//   psql [-h host] [-p port] [-U user] [-d db] [-q] [-A] [-t] [-At] [-F sep] [-v ON_ERROR_STOP=1] (-c SQL | -f - | -f FILE)
// Output as `psql -A`: rows as col1|col2, NULL as empty, no header with -t,
// command tags (INSERT 0 1, UPDATE 3, ...) unless -q. Errors: "ERROR: ..." on
// stderr and exit code 1 (ON_ERROR_STOP behaviour, always).
// Connection: POSTGRES_* from the env file CRM_DEV_ENV (default local/dev/api.env)
// unless -h/-p/-U/-d say otherwise. Uses the `pg` package of parisahon-api.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const envFile = process.env.CRM_DEV_ENV || path.join(__dirname, 'api.env');
const env = {};
try {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    env[m[1]] = v;
  }
} catch (e) {
  console.error(`psql.js: cannot read ${envFile}: ${e.message}`);
  process.exit(2);
}

const opts = {
  host: env.POSTGRES_HOST || '127.0.0.1',
  port: Number(env.POSTGRES_PORT || 5432),
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DATABASE,
};
let sql = null;
let file = null;
let quiet = false;
let tuplesOnly = false;
let sep = '|';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h') opts.host = args[++i];
  else if (a === '-p') opts.port = Number(args[++i]);
  else if (a === '-U') opts.user = args[++i];
  else if (a === '-d') opts.database = args[++i];
  else if (a === '-c') sql = args[++i];
  else if (a === '-f') file = args[++i];
  else if (a === '-F') sep = args[++i];
  else if (a === '-v') i++; // -v ON_ERROR_STOP=1 : always on here
  else if (/^-[AtqX]+$/.test(a)) {
    if (a.includes('q')) quiet = true;
    if (a.includes('t')) tuplesOnly = true;
  } else {
    console.error(`psql.js: unsupported argument ${a}`);
    process.exit(2);
  }
}
if (sql === null && file === null) {
  console.error('psql.js: give -c SQL or -f FILE (- for stdin)');
  process.exit(2);
}
if (file !== null) sql = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');

const { Client } = require(path.join(ROOT, 'parisahon-api', 'node_modules', 'pg'));
// every value as the text the server sends, like psql
const types = { getTypeParser: () => (v) => v };
const client = new Client({ ...opts, types });

const tag = (r) => {
  if (!r.command) return null;
  if (r.command === 'INSERT') return `INSERT 0 ${r.rowCount ?? 0}`;
  if (['UPDATE', 'DELETE', 'SELECT', 'MOVE', 'FETCH', 'COPY', 'MERGE'].includes(r.command)) return `${r.command} ${r.rowCount ?? 0}`;
  return r.command;
};

(async () => {
  await client.connect();
  let out = '';
  try {
    // types on the query itself: for multi-statement text pg builds each Result with the query's types
    // rowMode array: columns with the same name (`x IS NOT NULL, y IS NOT NULL`) would collapse in an object
    const res = await client.query({ text: sql, types, rowMode: 'array' });
    const results = Array.isArray(res) ? res : [res];
    // psql -c prints only the last statement's result; -f prints each one
    const shown = file !== null ? results : results.slice(-1);
    for (const r of shown) {
      if (r.fields && r.fields.length) {
        if (!tuplesOnly) out += r.fields.map((f) => f.name).join(sep) + '\n';
        for (const row of r.rows) out += row.map((v) => (v === null || v === undefined ? '' : String(v))).join(sep) + '\n';
        if (!tuplesOnly) out += `(${r.rows.length} row${r.rows.length === 1 ? '' : 's'})\n`;
      } else if (!quiet) {
        const t = tag(r);
        if (t) out += t + '\n';
      }
    }
    process.stdout.write(out);
  } catch (e) {
    process.stdout.write(out);
    console.error(`ERROR:  ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error(`psql.js: ${e.message}`);
  process.exit(2);
});
