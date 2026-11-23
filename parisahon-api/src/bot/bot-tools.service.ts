import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BotAccess, loadStaffUser } from './bot-access';
import { BotCrmService, PendingAction } from './bot-crm.service';

/**
 * The CRM tools Claude gets in the bot, served over MCP (bot-mcp.controller.ts).
 *
 * Each Claude run gets its own session token bound to one CRM user and chat,
 * valid only while the run lasts. A tool call is executed as that user, with
 * the user's current rights (re-read from the database on every call).
 */

export interface ToolSession {
  token: string;
  userId: number;
  chatId: string;
  expiresAt: number;
  /** Changes prepared during this run; the bot shows them with confirm buttons. */
  actions: PendingAction[];
}

type ToolDef<S extends z.ZodTypeAny> = {
  description: string;
  schema: S;
  run: (access: BotAccess, session: ToolSession, args: z.infer<S>) => Promise<unknown>;
};

const id = () => z.number().int().positive();

@Injectable()
export class BotToolsService {
  private readonly logger = new Logger(BotToolsService.name);
  private readonly sessions = new Map<string, ToolSession>();
  readonly tools: Record<string, ToolDef<any>>;

  constructor(
    private dataSource: DataSource,
    private crm: BotCrmService,
  ) {
    const tools: Record<string, ToolDef<any>> = {
      find_clients: {
        description:
          'Search client companies by part of the name, INN, phone or e-mail, also by a contact person\'s name/phone/e-mail. Returns up to 10 companies with their id.',
        schema: z.object({ query: z.string().min(2).max(200).describe('Name, INN, phone or e-mail') }),
        run: (access, _s, a) => this.crm.findClients(access, a.query),
      },
      get_client: {
        description: 'Full card of a client company: requisites, contacts, recent deals, number of open tasks, link to the CRM.',
        schema: z.object({ company_id: id() }),
        run: (access, _s, a) => this.crm.getClient(access, a.company_id),
      },
      list_deals: {
        description:
          'Deals (orders) visible to the manager. Filter by company, only the manager\'s own deals, status, or "stale": no activity for N days.',
        schema: z.object({
          company_id: id().optional(),
          mine: z.boolean().optional().describe('Only deals where the manager is responsible'),
          status: z.enum(['open', 'closed', 'all']).optional().describe('Default: open'),
          stale_days: z.number().int().min(1).max(365).optional().describe('Only deals without activity for at least this many days'),
          limit: z.number().int().min(1).max(30).optional(),
        }),
        run: (access, _s, a) => this.crm.listDeals(access, a),
      },
      client_history: {
        description:
          'History of a client company, newest first: Telegram and WhatsApp messages (incoming / outgoing, with attached files), e-mails, calls, comments, tasks, stage changes. Optionally only one deal (order).',
        schema: z.object({
          company_id: id(),
          deal_id: id().optional().describe('Only the history of this deal'),
          limit: z.number().int().min(1).max(40).optional(),
        }),
        run: (access, _s, a) => this.crm.clientHistory(access, a),
      },
      list_tasks: {
        description: "The manager's open tasks (assigned to them or to their group).",
        schema: z.object({
          period: z.enum(['today', 'overdue', 'week', 'open']).optional().describe('Default: today'),
          company_id: id().optional(),
          limit: z.number().int().min(1).max(40).optional(),
        }),
        run: (access, _s, a) => this.crm.listTasks(access, a),
      },
      prepare_task: {
        description:
          'Prepare a new task for the manager, linked to a deal or a company. Given a company_id, the task goes to the ' +
          "client's only open deal; with several open deals it returns status choose_deal and the deals: ask the manager " +
          'which one and call again with its deal_id (company_only: true links the task to the company itself). ' +
          'Nothing is saved until the manager presses the confirm button that the bot shows.',
        schema: z.object({
          title: z.string().min(3).max(255).describe('What to do, e.g. "Позвонить по образцам"'),
          date: z.string().describe('YYYY-MM-DD, local date'),
          time: z.string().optional().describe('HH:MM local time; omit for an all-day task'),
          duration_minutes: z.number().int().min(5).max(600).optional(),
          type: z.string().optional().describe('Task type name, e.g. "Встреча" or "Связаться"'),
          company_id: id().optional(),
          deal_id: id().optional().describe('The deal (order) the task is about; preferred over company_id'),
          company_only: z.boolean().optional().describe('Link to the company itself, not to one of its open deals'),
        }),
        run: async (access, s, a) => this.track(s, await this.crm.prepareTask(access, s.chatId, a)),
      },
      prepare_close_task: {
        description: 'Prepare closing (completing) a task with a result. Saved only after the manager confirms with a button.',
        schema: z.object({ task_id: id(), result: z.string().min(1).max(2000) }),
        run: async (access, s, a) => this.track(s, await this.crm.prepareCloseTask(access, s.chatId, a)),
      },
      prepare_company: {
        description:
          'Prepare a new client company with requisites and contact people. Checks for duplicates. Saved only after the manager confirms with a button.',
        schema: z.object({
          name: z.string().min(3).max(255),
          inn: z.string().max(20).optional(),
          phone: z.string().max(255).optional(),
          email: z.string().max(255).optional(),
          legal_address: z.string().max(1000).optional(),
          bank_account: z.string().max(34).optional(),
          bank_name: z.string().max(255).optional(),
          mfo: z.string().max(20).optional(),
          oked: z.string().max(20).optional(),
          director: z.string().max(255).optional(),
          contacts: z
            .array(
              z.object({
                full_name: z.string().min(1).max(255),
                position: z.string().max(255).optional(),
                phone: z.string().max(255).optional(),
                email: z.string().max(255).optional(),
              }),
            )
            .max(10)
            .optional(),
        }),
        run: async (access, s, a) => this.track(s, await this.crm.prepareCompany(access, s.chatId, a)),
      },
    };
    this.tools = tools;
  }

  private track(session: ToolSession, result: any) {
    if (result?.action_id) {
      const action = this.crm.getPending(result.action_id);
      if (action) session.actions.push(action);
    }
    return result;
  }

  // ------------------------------------------------------------- sessions

  openSession(userId: number, chatId: string, ttlSec: number): ToolSession {
    const now = Date.now();
    for (const [key, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(key);
    const session: ToolSession = {
      token: randomBytes(32).toString('base64url'),
      userId,
      chatId,
      expiresAt: now + ttlSec * 1000,
      actions: [],
    };
    this.sessions.set(session.token, session);
    return session;
  }

  closeSession(token: string) {
    this.sessions.delete(token);
  }

  findSession(token: string | undefined): ToolSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) return null;
    return session;
  }

  // ---------------------------------------------------------------- MCP

  list() {
    return Object.entries(this.tools).map(([name, t]) => {
      const { $schema, ...inputSchema } = z.toJSONSchema(t.schema) as any;
      return { name, description: t.description, inputSchema };
    });
  }

  /** Runs a tool; errors become a text result with isError, as MCP expects. */
  async call(session: ToolSession, name: string, rawArgs: unknown) {
    const tool = this.tools[name];
    if (!tool) return this.errorResult(`Нет такого инструмента: ${name}`);
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return this.errorResult(`Неверные параметры: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const user = await loadStaffUser(this.dataSource, session.userId);
    if (!user) return this.errorResult('Пользователь CRM удалён или заблокирован');
    try {
      const result = await tool.run(new BotAccess(user), session, parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof HttpException) {
        const response: any = error.getResponse();
        return this.errorResult(typeof response === 'string' ? response : response?.message ?? error.message);
      }
      this.logger.error(`tool ${name} failed: ${(error as Error)?.stack ?? error}`);
      return this.errorResult('Внутренняя ошибка CRM');
    }
  }

  private errorResult(message: unknown) {
    return { content: [{ type: 'text', text: `Ошибка: ${Array.isArray(message) ? message.join('; ') : String(message)}` }], isError: true };
  }
}
