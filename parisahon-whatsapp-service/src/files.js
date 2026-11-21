// Small file helpers: private directories and atomic private writes.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
}

/** Writes through a temporary file and a rename: a crash never leaves half a file. Mode 600. */
export async function writePrivateFile(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

export async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
