/*
 * Server-side permissions (src/auth/access.ts) on a COPY of the database (staging).
 * Creates two agents with "own" rights in different groups and their records, then checks that
 * agent A cannot read or change agent B's deal, company, contact, task, files, history.
 * Run inside the API container:  node local/checks/access_check.js   (env: the API's env)
 * Refuses to run on a database that is not named *staging* or *dev* / *test*.
 */
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const BASE = process.env.CHECK_API || 'http://127.0.0.1:3000/api/v1';
const db = process.env.POSTGRES_DATABASE || '';
if (!/staging|dev|test/i.test(db)) {
  console.error(`refusing to run on database "${db}"`);
  process.exit(2);
}

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'ok ' : 'BAD'} ${name}${ok ? '' : ' ' + extra}`);

async function api(token, method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let b = null;
  try { b = await r.json(); } catch { /* empty */ }
  return { s: r.status, b };
}

(async () => {
  const pg = new Client({
    host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT), user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD, database: db,
  });
  await pg.connect();
  const q = async (sql, params = []) => (await pg.query(sql, params)).rows;

  const groups = await q(`SELECT id FROM "group" ORDER BY id LIMIT 2`);
  if (groups.length < 2) throw new Error('need two groups');
  const own = { view: 1, create: 3, update: 1, delete: 1, export: 0 };
  const perms = { deal: own, company: own, contact: own, task: { update: 1, delete: 1 }, mail: false, file: true };
  const mkUser = async (name, groupId, permissions = perms) =>
    (await q(
      `INSERT INTO "user"(username, email, role, permissions, group_id, password) VALUES ($1, $2, 'agent', $3, $4, 'x') RETURNING id`,
      [name, `${name}@check.invalid`, permissions, groupId],
    ))[0].id;
  const A = await mkUser('QA-CHECK agent A', groups[0].id);
  const B = await mkUser('QA-CHECK agent B', groups[1].id);
  const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const ta = tok(A), tb = tok(B), tadmin = tok((await q(`SELECT id FROM "user" WHERE role='admin' AND deleted_at IS NULL ORDER BY id LIMIT 1`))[0].id);

  try {
    // B's records, created through the API as B
    const fillersC = (await api(tadmin, 'GET', '/fillers')).b?.company ?? [];
    const cf = fillersC.filter((f) => f.is_required).map((f) => ({ filler_id: f.id, value: 'QA' }));
    const fillersU = (await api(tadmin, 'GET', '/fillers')).b?.user ?? [];
    const uf = fillersU.filter((f) => f.is_required).map((f) => ({ filler_id: f.id, value: 'QA' }));
    const company = await api(tb, 'POST', '/companies', { name: `QA-CHECK company B ${Date.now()}`, is_old: false, fillers: cf });
    check('B creates a company', company.s === 201, JSON.stringify(company.b).slice(0, 160));
    const contact = await api(tb, 'POST', '/users', {
      username: `QA-CHECK contact B ${Date.now()}`, role: 'ctr_agent', company_id: company.b.id, fillers: uf,
    });
    check('B creates a contact', contact.s === 201, JSON.stringify(contact.b).slice(0, 160));
    const deal = await api(tb, 'POST', '/deals', {
      label: 'QA-CHECK deal B', budget: 100, agent_id: B, ctr_agent_ids: [contact.b.id], company_id: company.b.id, fillers: [], products: [],
    });
    check('B creates a deal', deal.s === 201, JSON.stringify(deal.b).slice(0, 160));
    const D = deal.b.id;
    const task = await api(tb, 'POST', '/tasks', {
      label: 'QA-CHECK task B', type_id: (await q(`SELECT id FROM task_type ORDER BY id LIMIT 1`))[0].id,
      assign_to: { target: 'agent', id: B }, link_to: { target: 'deal', id: D },
      start_time: new Date(Date.now() + 36e5).toISOString(), end_time: new Date(Date.now() + 72e5).toISOString(), allDay: false,
    });
    check('B creates a task', task.s === 201, JSON.stringify(task.b).slice(0, 160));
    const T = task.b.id;
    const dealA = await api(ta, 'POST', '/deals', { label: 'QA-CHECK deal A', budget: 50, agent_id: A, ctr_agent_ids: [], fillers: [], products: [] });

    // B still sees and changes everything of their own
    check('B reads own deal', (await api(tb, 'GET', `/deals/${D}`)).s === 200);
    check('B updates own deal', (await api(tb, 'PATCH', `/deals/${D}`, { budget: 120 })).s === 200);
    check('B reads own company', (await api(tb, 'GET', `/companies/${company.b.id}`)).s === 200);
    check('B reads own events', (await api(tb, 'GET', `/users/${B}/events`)).s === 200);

    // A: nothing of B
    const deny = async (name, method, path, body, codes = [403, 404]) => {
      const r = await api(ta, method, path, body);
      check(name, codes.includes(r.s), `got ${r.s}`);
    };
    await deny('A cannot read B deal', 'GET', `/deals/${D}`);
    await deny('A cannot read B deal history', 'GET', `/deals/${D}/events`);
    await deny('A cannot read B deal files', 'GET', `/deals/${D}/files`);
    await deny('A cannot read B client history', 'GET', `/deals/${D}/client-history`);
    await deny('A cannot update B deal', 'PATCH', `/deals/${D}`, { budget: 1 });
    await deny('A cannot move B deal stage', 'PATCH', `/deals/${D}/stage`, { stage_id: 2 });
    await deny('A cannot comment on B deal', 'POST', `/deals/${D}/comments`, { comment: 'QA-CHECK hack' });
    await deny('A cannot delete B deal', 'DELETE', `/deals/${D}`);
    await deny('A cannot read B company', 'GET', `/companies/${company.b.id}`);
    await deny('A cannot read B company deals', 'GET', `/companies/${company.b.id}/deals`);
    await deny('A cannot update B company', 'PATCH', `/companies/${company.b.id}`, { name: 'QA-CHECK hacked', fillers: [], users: [], fillers_create: [] });
    await deny('A cannot delete B company', 'DELETE', `/companies/${company.b.id}`);
    await deny('A cannot update B contact', 'PATCH', `/users/${contact.b.id}`, { username: 'QA-CHECK hacked', role: 'ctr_agent', company_id: company.b.id, fillers: [], fillers_create: [] });
    await deny('A cannot delete B contact', 'DELETE', `/users/${contact.b.id}`);
    await deny('A cannot update B task', 'PATCH', `/tasks/${T}`, { label: 'QA-CHECK hacked' });
    await deny('A cannot close B task', 'PATCH', `/tasks/${T}/close`, { result: 'QA-CHECK hacked' });
    await deny('A cannot delete B task', 'DELETE', `/tasks/${T}`);
    // a task carries its deal (label, budget), company (requisites) and contact (task-access.ts)
    await deny('A cannot read B task', 'GET', `/tasks/${T}`);
    const tasksOfD = await api(ta, 'GET', `/tasks?deal_id=${D}&type=all&limit=1000`);
    check('A task list hides the tasks of B deal', tasksOfD.s === 200 && !tasksOfD.b.data.some((t) => t.id === T), `status ${tasksOfD.s}`);
    await deny('A cannot put a task on B deal (it went into its history)', 'POST', '/tasks', {
      label: 'QA-CHECK task A on B deal', assign_to: { target: 'agent', id: A }, link_to: { target: 'deal', id: D },
      start_time: new Date(Date.now() + 36e5).toISOString(), end_time: new Date(Date.now() + 72e5).toISOString(), allDay: false,
    });
    // ACL-8: the task level of the card decides whom a task may be given to and which unlinked tasks are seen
    await deny('A (own task level) cannot give a task to B of another group', 'POST', '/tasks', {
      label: 'QA-CHECK task A for B', assign_to: { target: 'agent', id: B }, link_to: { target: 'deal', id: dealA.b?.id },
      start_time: new Date(Date.now() + 36e5).toISOString(), end_time: new Date(Date.now() + 72e5).toISOString(), allDay: false,
    }, [403]);
    const loose = (await q(
      `INSERT INTO task (label, start_time, end_time, type_id, agent_id, "createdById")
       VALUES ('QA-CHECK task B loose', now() + interval '1 day', now() + interval '25 hours', (SELECT id FROM task_type ORDER BY id LIMIT 1), $1, $1)
       RETURNING id`,
      [B],
    ))[0].id;
    await deny('A cannot read B task without a client', 'GET', `/tasks/${loose}`, undefined, [404]);
    const looseList = await api(ta, 'GET', `/tasks?assigned_to[]=${B}&type=all&limit=1000`);
    check('A task list hides B task without a client', looseList.s === 200 && !looseList.b.data.some((t) => t.id === loose), `status ${looseList.s}`);
    // ACL-13: «Для группы» lets change the tasks of the colleagues of the group (task.group_id is empty)
    const groupLevel = { view: 2, create: 3, update: 2, delete: 2, export: 0 };
    const C = await mkUser('QA-CHECK agent C', groups[1].id, { ...perms, deal: groupLevel, task: { update: 2, delete: 2 } });
    const byC = await api(tok(C), 'PATCH', `/tasks/${T}`, { label: 'QA-CHECK task B (changed by C)' });
    check('C (group task level, B group) changes B task', byC.s === 200, `got ${byC.s} ${JSON.stringify(byC.b).slice(0, 160)}`);
    const looseByC = await api(tok(C), 'PATCH', `/tasks/${loose}`, { label: 'QA-CHECK task B loose (C)' });
    check('C changes B task without a client too', looseByC.s === 200, `got ${looseByC.s}`);
    const byA = await api(ta, 'PATCH', `/tasks/${loose}`, { label: 'QA-CHECK hacked' });
    check('A (another group) still cannot change it', [403, 404].includes(byA.s), `got ${byA.s}`);

    await deny('A cannot read B events', 'GET', `/users/${B}/events`);
    await deny('A cannot read B recordings', 'GET', `/users/${B}/recordings`);
    await deny('A cannot read B files', 'GET', `/users/${B}/files`);
    await deny('A cannot read B deals', 'GET', `/users/${B}/deals`);
    await deny('A cannot delete a product', 'DELETE', `/products/999999`, undefined, [403]);

    const list = await api(ta, 'GET', `/deals?limit=1000`);
    check('A deal list hides B deal', list.s === 200 && !list.b.data.some((d) => d.id === D), `status ${list.s}`);
    check('A deal list shows own deal', list.s === 200 && list.b.data.some((d) => d.id === dealA.b?.id));
    const adm = await api(tadmin, 'GET', `/deals/${D}`);
    check('admin reads B deal', adm.s === 200);

    // nothing changed
    const after = (await q(`SELECT budget, label FROM deal WHERE id = $1`, [D]))[0];
    check('B deal untouched', after && Number(after.budget) === 120 && after.label === 'QA-CHECK deal B', JSON.stringify(after));
    const comp = (await q(`SELECT name, deleted_at FROM company WHERE id = $1`, [company.b.id]))[0];
    check('B company untouched', comp && !comp.name.includes('hacked') && comp.deleted_at === null, JSON.stringify(comp));
  } finally {
    // clean up everything named QA-CHECK
    await q(`DELETE FROM task WHERE label LIKE 'QA-CHECK%'`);
    await q(`DELETE FROM event WHERE deal_id IN (SELECT id FROM deal WHERE label LIKE 'QA-CHECK%')`);
    await q(`DELETE FROM deal_user WHERE "dealId" IN (SELECT id FROM deal WHERE label LIKE 'QA-CHECK%')`);
    await q(`DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM deal WHERE label LIKE 'QA-CHECK%')`).catch(() => undefined);
    await q(`DELETE FROM deal WHERE label LIKE 'QA-CHECK%'`);
    await q(`DELETE FROM user_filler WHERE user_id IN (SELECT id FROM "user" WHERE username LIKE 'QA-CHECK%')`);
    await q(`DELETE FROM event WHERE user_id IN (SELECT id FROM "user" WHERE username LIKE 'QA-CHECK%') OR target_user_id IN (SELECT id FROM "user" WHERE username LIKE 'QA-CHECK%')`).catch(() => undefined);
    await q(`DELETE FROM company_filler WHERE company_id IN (SELECT id FROM company WHERE name LIKE 'QA-CHECK%')`);
    await q(`UPDATE "user" SET company_id = NULL WHERE username LIKE 'QA-CHECK%'`);
    await q(`DELETE FROM event WHERE company_id IN (SELECT id FROM company WHERE name LIKE 'QA-CHECK%')`).catch(() => undefined);
    await q(`DELETE FROM notification WHERE company_id IN (SELECT id FROM company WHERE name LIKE 'QA-CHECK%')`).catch(() => undefined);
    await q(`DELETE FROM company WHERE name LIKE 'QA-CHECK%'`).catch((e) => results.push('cleanup company: ' + e.message));
    await q(`DELETE FROM "user" WHERE username LIKE 'QA-CHECK%'`).catch((e) => results.push('cleanup users: ' + e.message));
    await pg.end();
  }
  console.log(results.join('\n'));
  const bad = results.filter((r) => r.startsWith('BAD')).length;
  console.log(`\n${results.length - bad}/${results.length} ok`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('check failed:', e.message);
  console.log(results.join('\n'));
  process.exit(1);
});
