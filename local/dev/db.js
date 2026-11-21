#!/usr/bin/env node
// Dev database of the CRM on the trial Postgres (~/parisa-crm, port 55434).
//   node local/dev/db.js create    - parisahon_dev as a copy of the trial db `parisahon`
//                                    (CREATE DATABASE ... TEMPLATE), then the admin password
//                                    from local/dev/api.env; does nothing if it already exists
//   node local/dev/db.js recreate  - drop and create again (the dev data is thrown away)
//   node local/dev/db.js drop
// The trial database is only read (as a template). It must have no other connections
// for a moment: the script retries a few times, and if the trial API holds one it says so.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const envFile = process.env.CRM_DEV_ENV || path.join(__dirname, 'api.env');
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
}
const SOURCE = process.env.CRM_DEV_TEMPLATE_DB || 'parisahon';
const TARGET = env.POSTGRES_DATABASE;
if (!TARGET || TARGET === SOURCE || !/^[a-z0-9_]+$/.test(TARGET)) {
  console.error(`db.js: refusing to work on database "${TARGET}"`);
  process.exit(2);
}
const { Client } = require(path.join(ROOT, 'parisahon-api', 'node_modules', 'pg'));
const bcrypt = require(path.join(ROOT, 'parisahon-api', 'node_modules', 'bcryptjs'));
const base = { host: env.POSTGRES_HOST, port: Number(env.POSTGRES_PORT), user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withClient(database, fn) {
  const c = new Client({ ...base, database });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function exists(admin) {
  return (await admin.query('select 1 from pg_database where datname = $1', [TARGET])).rowCount > 0;
}

async function drop(admin) {
  await admin.query(`drop database if exists ${TARGET} with (force)`);
  console.log(`dropped ${TARGET}`);
}

async function create(admin) {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`create database ${TARGET} template ${SOURCE}`);
      break;
    } catch (e) {
      if (!/being accessed by other users/.test(e.message) || attempt >= 10) throw e;
      if (attempt === 1) console.log(`waiting for the connections to ${SOURCE} to close (the trial API opens them on demand)...`);
      await sleep(3000);
    }
  }
  await withClient(TARGET, async (db) => {
    const hash = await bcrypt.hash(env.ADMIN_PASSWORD, await bcrypt.genSalt(10));
    const r = await db.query('update "user" set password = $1 where email = $2 and role = $3 returning id', [hash, env.ADMIN_EMAIL || 'admin@gmail.com', 'admin']);
    if (!r.rowCount) console.log('no admin user found in the copy: the API seeds one on start');
    // nothing from the dev copy must reach real managers: forget the bot links of the trial data
    for (const t of ['bot_account', 'bot_link_code']) {
      try { await db.query(`delete from ${t}`); } catch (e) { /* table may not exist yet */ }
    }
    // the copied emails belong to the production mailbox: their IMAP uids mean nothing on the
    // dev mail stand-in and would collide with its uids, so they stay as local copies only
    try { await db.query('update email set email_id = null, uidvalidity = null'); } catch (e) { /* older schema */ }
    const n = await db.query('select (select count(*) from "user") u, (select count(*) from company) c, (select count(*) from deal) d');
    console.log(`created ${TARGET} from ${SOURCE}: users ${n.rows[0].u}, companies ${n.rows[0].c}, deals ${n.rows[0].d}; admin password set from ${path.basename(envFile)}`);
  });
}

(async () => {
  const cmd = process.argv[2];
  await withClient('postgres', async (admin) => {
    if (cmd === 'create') {
      if (await exists(admin)) return console.log(`${TARGET} already exists (use recreate to rebuild it)`);
      await create(admin);
    } else if (cmd === 'recreate') {
      if (await exists(admin)) await drop(admin);
      await create(admin);
    } else if (cmd === 'drop') {
      if (await exists(admin)) await drop(admin); else console.log(`${TARGET} does not exist`);
    } else {
      console.error('usage: db.js create | recreate | drop');
      process.exit(2);
    }
  });
})().catch((e) => {
  console.error(`db.js: ${e.message}`);
  process.exit(1);
});
