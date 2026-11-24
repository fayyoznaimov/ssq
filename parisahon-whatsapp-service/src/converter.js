// Where ffmpeg is (HACK-10; not named ffmpeg*.js: the deploy leaves ffmpeg* out): one variable for the API and both messenger services, FFMPEG_BIN.
//   FFMPEG_BIN=/usr/bin/ffmpeg   a path (the Debian ffmpeg of the image), or a name looked up in PATH;
//   empty                        "ffmpeg" from PATH.
// A configured path that does not exist (an old mount such as /opt/ffmpeg that is empty now) is not
// trusted blindly: "ffmpeg" from PATH is tried next. The binary must answer `ffmpeg -version`.
// Nothing found: voice messages stay .ogg, no video thumbnails, and GET /health shows ffmpeg: false.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** "ffmpeg" -> the first executable of that name in PATH; a path -> itself when it exists. */
export function locate(bin, env = process.env) {
  if (!bin) return ''
  if (bin.includes('/') || bin.includes('\\')) {
    const abs = path.resolve(bin)
    return isExecutable(abs) ? abs : ''
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of process.platform === 'win32' ? [bin, `${bin}.exe`] : [bin]) {
      const candidate = path.join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return ''
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Does the binary run (`-version`)? */
export function answers(bin, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: timeoutMs }, (error, stdout) => resolve(!error && /ffmpeg version/i.test(String(stdout))))
  })
}

/**
 * The ffmpeg to use: { bin, ok, tried } — bin '' when none works.
 * check(bin) is injectable for the tests.
 */
export async function findFfmpeg(configured, { env = process.env, check = answers } = {}) {
  const tried = []
  for (const name of [...new Set([String(configured || '').trim(), 'ffmpeg'].filter(Boolean))]) {
    const bin = locate(name, env)
    tried.push(bin ? `${name} -> ${bin}` : `${name}: not found`)
    if (bin && (await check(bin))) return { bin, ok: true, tried }
  }
  return { bin: '', ok: false, tried }
}
