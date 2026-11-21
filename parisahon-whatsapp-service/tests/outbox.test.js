import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CrmClient, Outbox } from '../src/outbox.js'
import { fakeCrm, tempDir, newKey, silent } from './helpers.js'

const payload = (id, text = 'hi') => ({ agent_id: 1, agent_phone: '+998901234567', chat: { wa_id: '998907654321@s.whatsapp.net', phone: '+998907654321', name: null }, wa_message_id: id, text, outgoing: false, date: '2026-11-19T10:00:00+05:00', files: [] })

async function setup(more = {}) {
  const crm = await fakeCrm()
  const dir = await tempDir()
  const key = newKey()
  let clock = 1_000_000
  const results = []
  const make = () => new Outbox({
    file: path.join(dir, 'outbox.json'), key, pollSec: 10, maxBackoffSec: 60, logger: silent,
    client: new CrmClient({ baseUrl: crm.url, token: 'tok-1', timeoutMs: 2000 }),
    onResult: (p, r) => results.push([p.wa_message_id, r.status]), now: () => clock, ...more,
  })
  return { crm, dir, key, make, results, tick: (ms) => { clock += ms }, file: path.join(dir, 'outbox.json') }
}

test('201: delivered at once, with the service token header', async (t) => {
  const s = await setup()
  t.after(() => s.crm.close())
  const box = s.make()
  const result = await box.deliver(payload('M1', 'secret text'))
  assert.deepEqual(result, { status: 'saved' })
  assert.equal(s.crm.requests.length, 1)
  const req = s.crm.requests[0]
  assert.equal(req.url, '/api/v1/whatsapp/incoming')
  assert.equal(req.headers['x-whatsapp-service-token'], 'tok-1')
  assert.equal(req.body.wa_message_id, 'M1')
  assert.equal(box.size, 0)
  assert.deepEqual(s.results, [['M1', 'saved']])
})

test('5xx: kept in a sealed outbox, retried in order with a growing pause, survives a restart', async (t) => {
  const s = await setup()
  t.after(() => s.crm.close())
  s.crm.status = 503
  const box = s.make()
  assert.equal(await box.deliver(payload('M1', 'secret text')), null)
  assert.equal(box.size, 1)
  const first = box.nextAt
  assert.equal(first, 1_000_000 + 10_000)
  // a new message waits behind the old one (no request while the pause runs)
  assert.equal(await box.deliver(payload('M2')), null)
  assert.equal(s.crm.requests.length, 1)
  assert.equal(box.size, 2)
  const onDisk = await fs.readFile(s.file, 'utf8')
  assert.equal(JSON.parse(onDisk).alg, 'aes-256-gcm')
  assert.ok(!onDisk.includes('secret text'))
  assert.equal((await fs.stat(s.file)).mode & 0o777, 0o600)

  s.tick(10_000)
  await box.flush() // still 503: pause doubles
  assert.equal(box.nextAt - 1_010_000, 20_000)
  s.tick(20_000)
  await box.flush()
  assert.equal(box.nextAt - 1_030_000, 40_000)
  s.tick(40_000)
  await box.flush()
  assert.equal(box.nextAt - 1_070_000, 60_000) // capped by maxBackoffSec

  // restart: a new outbox reads the file
  const after = s.make()
  await after.load()
  assert.equal(after.size, 2)
  s.crm.status = 201
  const before = s.crm.requests.length
  assert.equal(await after.flush(), 2)
  assert.deepEqual(s.crm.requests.slice(before).map((r) => r.body.wa_message_id), ['M1', 'M2'])
  assert.equal(after.size, 0)
  const reloaded = s.make()
  await reloaded.load()
  assert.equal(reloaded.size, 0)
})

test('network error: queued like a 5xx', async (t) => {
  const s = await setup()
  await s.crm.close()
  const box = s.make()
  box.client = new CrmClient({ baseUrl: s.crm.url, token: 'tok-1', timeoutMs: 1000 })
  assert.equal(await box.deliver(payload('N1')), null)
  assert.equal(box.size, 1)
  t.after(() => {})
})

test('4xx: logged and dropped, never queued; a refused queued message does not block the others', async (t) => {
  const s = await setup()
  t.after(() => s.crm.close())
  s.crm.status = 400
  const box = s.make()
  assert.equal(await box.deliver(payload('BAD')), null)
  assert.equal(box.size, 0)

  s.crm.status = 500
  await box.deliver(payload('Q1'))
  await box.deliver(payload('Q2'))
  s.crm.status = (n) => (s.crm.requests[n - 1].body.wa_message_id === 'Q1' ? 422 : 201)
  s.tick(60_000)
  assert.equal(await box.flush(), 1)
  assert.equal(box.size, 0)
  assert.deepEqual(s.results, [['Q2', 'saved']])
})

test('a wrong key: the outbox file is moved aside, the service goes on', async (t) => {
  const s = await setup()
  t.after(() => s.crm.close())
  s.crm.status = 500
  await s.make().deliver(payload('K1'))
  const other = s.make()
  other.key = newKey()
  await other.load()
  assert.equal(other.size, 0)
  const names = await fs.readdir(s.dir)
  assert.ok(names.some((n) => n.startsWith('outbox.json.unreadable-')), names.join(','))
})
