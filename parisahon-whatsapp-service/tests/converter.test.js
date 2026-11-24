// HACK-10: one way to find ffmpeg (FFMPEG_BIN, else "ffmpeg" from PATH); an empty old mount is not trusted.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { findFfmpeg, locate } from '../src/converter.js'
import { tempDir } from './helpers.js'

async function fakeBin(dir, name = 'ffmpeg') {
  const file = path.join(dir, name)
  await fs.writeFile(file, '#!/bin/sh\necho "ffmpeg version 6.1"\n', { mode: 0o755 })
  return file
}

test('a configured path that exists is used', { skip: process.platform === 'win32' && 'posix only' }, async (t) => {
  const dir = await tempDir()
  const bin = await fakeBin(dir)
  const found = await findFfmpeg(bin, { env: { PATH: '' }, check: async () => true })
  assert.deepEqual([found.ok, found.bin], [true, bin])
})

test('a configured path that is gone (an empty old mount) -> "ffmpeg" from PATH', { skip: process.platform === 'win32' && 'posix only' }, async (t) => {
  const dir = await tempDir()
  const bin = await fakeBin(dir)
  const found = await findFfmpeg('/opt/ffmpeg/ffmpeg', { env: { PATH: dir }, check: async () => true })
  assert.deepEqual([found.ok, found.bin], [true, bin])
  assert.match(found.tried[0], /not found/)
})

test('a binary that does not answer -version is not used; none at all -> ok false, empty bin', { skip: process.platform === 'win32' && 'posix only' }, async (t) => {
  const dir = await tempDir()
  await fakeBin(dir)
  const found = await findFfmpeg('', { env: { PATH: dir }, check: async () => false })
  assert.deepEqual([found.ok, found.bin], [false, ''])
  assert.equal(locate('ffmpeg', { PATH: '' }), '')
})

test('the real check runs the binary', { skip: process.platform === 'win32' && 'posix only' }, async (t) => {
  const dir = await tempDir()
  const bin = await fakeBin(dir)
  const found = await findFfmpeg(bin, { env: { PATH: '' } })
  assert.equal(found.ok, true)
})
