import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../auth/decorator/public.decorator';
import { BotToolsService } from './bot-tools.service';

/**
 * MCP endpoint (Streamable HTTP, JSON responses only) for the Claude CLI that
 * the bot starts. Not for people and not for the internet:
 *  - only connections from this machine (127.0.0.1 / ::1) are accepted, so a
 *    request that came through nginx or a tunnel is refused;
 *  - the bearer token is a per-run session token from BotToolsService, not a
 *    CRM login token; it dies when the run ends.
 * The JWT guard is skipped (@Public) because of that own token check.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

@Public()
@Controller('bot/mcp')
export class BotMcpController {
  constructor(private tools: BotToolsService) {}

  @Get()
  @HttpCode(405)
  get() {
    return { error: 'Use POST' };
  }

  @Delete()
  @HttpCode(405)
  remove() {
    return { error: 'No sessions to delete' };
  }

  @Post()
  async post(@Req() req: Request, @Res() res: Response) {
    const remote = req.socket.remoteAddress ?? '';
    if (!LOOPBACK.has(remote) || req.headers['x-forwarded-for'] || req.headers['x-real-ip']) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const auth = String(req.headers.authorization ?? '');
    const session = this.tools.findSession(auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined);
    if (!session) return res.status(401).json({ error: 'unauthorized' });

    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const message of messages) {
      const reply = await this.handle(session, message);
      if (reply) replies.push(reply);
    }
    if (!replies.length) return res.status(202).end();
    return res.status(200).json(Array.isArray(body) ? replies : replies[0]);
  }

  private async handle(session: Parameters<BotToolsService['call']>[0], message: any) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = message;
    // notifications (no id) get no answer
    if (id === undefined || id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'parisa-crm', version: '1.0.0' },
          instructions: 'Tools of the Parisa CRM, executed as the current manager with their rights.',
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.tools.list() });
      case 'tools/call':
        return ok(await this.tools.call(session, String(params?.name ?? ''), params?.arguments));
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }
}
