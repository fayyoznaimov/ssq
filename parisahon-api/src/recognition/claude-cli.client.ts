import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

/**
 * One request to Claude through the Claude Code CLI (`claude -p`) signed in on
 * the server: the same claude.ai login the OpenClaw bots use, so the CRM needs
 * no API key of its own.
 *
 * The model gets NO tools (`--tools ""`, no MCP, no settings, no slash
 * commands): the document is untrusted, and with tools a crafted card could
 * make it run commands on the server. The image or PDF goes inline in the
 * message (stream-json input), so the model doesn't need a file tool to see it.
 *
 * Settings (env):
 *   CLAUDE_BIN          path to the binary (default: `claude` from PATH)
 *   CLAUDE_TIMEOUT_SEC  request deadline (default 120)
 */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

export type ClaudeCliRun = {
  system: string;
  content: ClaudeContentBlock[];
  model: string;
  /** Reasoning effort (low, medium, high, xhigh, max); the CLI default when omitted. */
  effort?: string;
  timeoutSec?: number;
  /**
   * MCP servers whose tools the model may use (the CRM tools of the bot).
   * Built-in tools stay off in any case; only `allowedTools` run without a prompt.
   */
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  maxTurns?: number;
};

export type ClaudeCliResult = { text: string; model: string | null; tools: string[] };

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    /** true when the CLI itself is missing or not signed in, not the request */
    readonly unavailable = false,
  ) {
    super(message);
  }
}

/**
 * The CLI gets only what it needs from the CRM's environment: never the database password, the
 * JWT secret or the bot / mail / messenger tokens. ANTHROPIC_* are not passed either: with them it
 * would bill an API key instead of the login (CLAUDE_CODE_OAUTH_TOKEN).
 */
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // FAKE_CLAUDE_*: switches of the stand-in CLI of the tests (local/fake-claude), nothing in production
    if (PASSED_ENV.includes(name) || name.startsWith('CLAUDE_CODE_') || name.startsWith('FAKE_CLAUDE_') || name === 'CLAUDE_CONFIG_DIR') env[name] = value;
  }
  return env;
}

/** At most CLAUDE_MAX_PARALLEL (2) CLI processes at a time; up to 20 more wait, the rest are refused. */
const MAX_PARALLEL = Math.max(1, Number(process.env.CLAUDE_MAX_PARALLEL || 2));
const MAX_QUEUE = 20;
let running = 0;
const queue: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  if (queue.length >= MAX_QUEUE) throw new ClaudeCliError('Claude сейчас занят, попробуйте через минуту');
  await new Promise<void>((resolve) => queue.push(resolve));
  running++;
}
function release(): void {
  running--;
  const next = queue.shift();
  if (next) next();
}

@Injectable()
export class ClaudeCliClient {
  private readonly bin = process.env.CLAUDE_BIN || 'claude';

  async run(options: ClaudeCliRun): Promise<ClaudeCliResult> {
    const timeoutSec = Math.max(30, Number(options.timeoutSec || process.env.CLAUDE_TIMEOUT_SEC || 120));
    // The MCP config may carry a session token: a private file, not the command line (visible in ps)
    let mcpFile: string | null = null;
    if (options.mcpServers) {
      mcpFile = join(tmpdir(), `crm-mcp-${randomBytes(8).toString('hex')}.json`);
      await writeFile(mcpFile, JSON.stringify({ mcpServers: options.mcpServers }), { mode: 0o600 });
    }
    await acquire();
    try {
      return await this.runWith(options, timeoutSec, mcpFile);
    } finally {
      release();
      if (mcpFile) await unlink(mcpFile).catch(() => undefined);
    }
  }

  private async runWith(options: ClaudeCliRun, timeoutSec: number, mcpFile: string | null): Promise<ClaudeCliResult> {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', options.model,
      ...(options.effort ? ['--effort', options.effort] : []),
      // our prompt replaces Claude Code's own (coding assistant) system prompt
      '--system-prompt', options.system,
      // no built-in tools at all: no Bash, no files, no web
      '--tools', '',
      ...(mcpFile
        ? ['--mcp-config', mcpFile, '--allowedTools', (options.allowedTools ?? []).join(',')]
        : ['--disallowedTools', 'mcp__*']),
      // only the MCP servers given here, none from the machine's config
      '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--max-turns', String(options.maxTurns ?? 1),
    ];
    const message = { type: 'user', message: { role: 'user', content: options.content } };

    const { stdout, stderr, code } = await this.spawn(args, JSON.stringify(message) + '\n', timeoutSec);
    const events = stdout
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event && typeof event === 'object');
    const result = events.filter((event) => event.type === 'result').pop();
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init');

    if (!result) {
      const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300);
      if (detail) console.warn(`[ClaudeCliClient] no result (code ${code}): ${detail}`);
      throw new ClaudeCliError(`Claude не вернул результат (код ${code})`, true);
    }
    if (result.is_error || result.subtype !== 'success') {
      const detail = String(result.result || result.api_error_status || result.subtype || 'неизвестная ошибка').slice(0, 300);
      // 401/403 or "please /login": the server's Claude login expired
      const signedOut = [401, 403].includes(Number(result.api_error_status)) || /log ?in|authenticat|api key/i.test(detail);
      throw new ClaudeCliError(signedOut ? `вход Claude на сервере не действует (${detail})` : `Claude: ${detail}`, signedOut);
    }
    const text = String(result.result ?? '').trim();
    if (!text) throw new ClaudeCliError('Claude вернул пустой ответ');
    return { text, model: init?.model ?? null, tools: Array.isArray(init?.tools) ? init.tools : [] };
  }

  private async spawn(args: string[], input: string, timeoutSec: number) {
    // a private empty working directory per run, removed afterwards
    const cwd = await mkdtemp(join(tmpdir(), 'crm-claude-'));
    try {
      return await this.spawnIn(cwd, args, input, timeoutSec);
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawnIn(cwd: string, args: string[], input: string, timeoutSec: number) {
    return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      // No shell: arguments go as an array, recognized text can't become a command.
      const child = spawn(this.bin, args, { cwd, windowsHide: true, env: cliEnv() });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new ClaudeCliError(`Claude не ответил за ${timeoutSec} с`));
      }, timeoutSec * 1000);

      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          error?.code === 'ENOENT'
            ? new ClaudeCliError(`Не найден исполняемый файл «${this.bin}». Укажите путь в CLAUDE_BIN.`, true)
            : error,
        );
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input, 'utf8');
    });
  }
}

/** Index of the brace closing the object that starts at `start` (strings and escapes respected). */
export function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
