import { DataSource, EntityManager } from 'typeorm';
import { AuditLog } from './audit-log.entity';
import { ACTION_TEXT, AuditJournal } from './audit-journal';
import { EntitySpec, FieldSpec, RefKind, entityName, isQuiet, isSecret, specOfEntity } from './audit-registry';

/**
 * The journal in human language, as the version history of 1C and the change log of SAP show it
 * (the MES of the same company does it the same way, _app/changes.py): an operation (who, when,
 * from where) → its objects («Сделка №123 «Полотенца»») → their attributes with Russian names and
 * the old and the new value as people see them: names instead of ids, sums and dates formatted,
 * «да» / «нет», secrets as «изменён». Service columns are not repeated: who and when stand in the
 * head of the operation. A removal and an insertion of the same thing in one operation (a product
 * taken off and put back by one save) is one change.
 */

export interface RenderedField {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
  /** a sum: the difference («+2 000»); a list: what was added and taken away */
  delta?: string | null;
  /** one value, not «было → стало»: a secret «изменён», a JSON «изменено», a photo */
  single?: boolean;
}

export interface RenderedChange {
  kind: 'change';
  id: string;
  at: string;
  batch: string;
  request_id: string | null;
  actor: { id: number | null; name: string; deleted: boolean; automation: boolean };
  source: string;
  /** the badge: «бот», «триггер», «автопилот»…; none for a person in the web client */
  source_label: string | null;
  /** what acted, when it was not a person: «Триггер №5 «создать задачу» · этап «Новые»» */
  source_text: string | null;
  /** the person whose action set the automation off */
  caused_by: string | null;
  action: string;
  action_text: string;
  entity: string;
  entity_text: string;
  entity_id: string | null;
  object: string;
  link: string | null;
  deal_id: number | null;
  company_id: number | null;
  contact_id: number | null;
  fields: RenderedField[];
  summary: string | null;
}

export const SOURCE_LABEL: Record<string, string | null> = {
  web: null,
  bot: 'бот',
  trigger: 'триггер',
  autopilot: 'автопилот',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  ftp: 'FTP',
  ai: 'ИИ',
  mail: 'почта',
  system: 'система',
};

/** Who did it, when it was not a person. */
const AUTOMATION_NAME: Record<string, string> = {
  web: 'Система',
  bot: 'Бот CRM',
  trigger: 'Триггер',
  autopilot: 'Автопилот CRM',
  telegram: 'Telegram менеджера',
  whatsapp: 'WhatsApp менеджера',
  ftp: 'Записи звонков с телефона',
  ai: 'ИИ',
  mail: 'Почта',
  system: 'Система',
};

const PERMISSION_ENTITIES: Record<string, string> = { deal: 'Сделки', contact: 'Контакты', company: 'Компании', task: 'Задачи' };
const PERMISSION_ACTIONS: Record<string, string> = {
  view: 'просмотр',
  create: 'создание',
  update: 'изменение',
  delete: 'удаление',
  export: 'выгрузка',
};
const LEVELS: Record<string, string> = { '0': 'нет', '1': 'свои', '2': 'своей группы', '3': 'все' };
const OBJECTIVES: Record<string, string> = { monthly: 'на месяц', quarterly: 'на квартал', yearly: 'на год' };

const NBSP = ' ';
const pad = (n: number) => String(n).padStart(2, '0');

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** 1250000.5 → «1 250 000,5» */
export function formatNumber(value: unknown, decimals = 3): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const [whole, fraction] = Math.abs(n).toFixed(decimals).split('.');
  const tail = (fraction ?? '').replace(/0+$/, '');
  return `${n < 0 ? '−' : ''}${groupDigits(whole)}${tail ? `,${tail}` : ''}`;
}

/** «10 000»; a budget of -1 is how the deal form stored «no budget» */
export function formatMoney(value: unknown): string {
  const n = Number(value);
  if (Number.isFinite(n) && n < 0) return 'не указан';
  return formatNumber(value, 2);
}

/** 25.11.2026 18:00 in the zone of the CRM (process TZ, Asia/Karachi); a date without time — 25.11.2026 */
export function formatDateTime(value: unknown): string {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text.slice(8, 10)}.${text.slice(5, 7)}.${text.slice(0, 4)}`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return String(value);
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, 1)} КБ`;
  return `${formatNumber(n / 1024 / 1024, 1)} МБ`;
}

/** A browser in a few words: «Chrome, Windows». */
export function browserOf(agent: unknown): string | null {
  const text = typeof agent === 'string' ? agent : '';
  if (!text) return null;
  const browser = /Edg\//.test(text)
    ? 'Edge'
    : /OPR\//.test(text)
      ? 'Opera'
      : /YaBrowser/.test(text)
        ? 'Яндекс Браузер'
        : /Chrome\//.test(text)
          ? 'Chrome'
          : /Firefox\//.test(text)
            ? 'Firefox'
            : /Safari\//.test(text)
              ? 'Safari'
              : /python|curl|node|axios|okhttp/i.test(text)
                ? 'программа'
                : 'браузер';
  const system = /Android/.test(text)
    ? 'Android'
    : /iPhone|iPad|iOS/.test(text)
      ? 'iOS'
      : /Windows/.test(text)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(text)
          ? 'macOS'
          : /Linux/.test(text)
            ? 'Linux'
            : '';
  return system ? `${browser}, ${system}` : browser;
}

interface RefValue {
  name: string;
  deleted?: boolean;
  extra?: Record<string, any>;
}

/** The names of what the rows point at, read in one query per kind. */
class Refs {
  private wanted = new Map<RefKind, Set<number>>();
  private values = new Map<string, RefValue>();

  want(kind: RefKind | undefined, value: unknown): void {
    if (!kind) return;
    for (const item of Array.isArray(value) ? value : [value]) {
      const id = Number(item);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!this.wanted.has(kind)) this.wanted.set(kind, new Set());
      this.wanted.get(kind).add(id);
    }
  }

  get(kind: RefKind, value: unknown): RefValue | undefined {
    return this.values.get(`${kind}:${Number(value)}`);
  }

  name(kind: RefKind, value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    const ref = this.get(kind, value);
    if (!ref) return `${FALLBACK[kind]} №${value}`;
    return ref.deleted ? `${ref.name} (удалён)` : ref.name;
  }

  async load(db: DataSource | EntityManager): Promise<void> {
    const ids = (kind: RefKind) => [...(this.wanted.get(kind) ?? [])];
    const put = (kind: RefKind, rows: any[], name: (row: any) => string, deleted?: (row: any) => boolean) => {
      for (const row of rows) {
        this.values.set(`${kind}:${Number(row.id)}`, { name: name(row), deleted: deleted ? deleted(row) : false, extra: row });
      }
    };
    const query = async (kind: RefKind, sql: string): Promise<any[]> => {
      const list = ids(kind);
      if (!list.length) return [];
      return db.query(sql, [list]);
    };
    put('user', await query('user', `SELECT id, username, role, deleted_at FROM "user" WHERE id = ANY($1::int[])`), (r) => r.username || `№${r.id}`, (r) => !!r.deleted_at);
    put('group', await query('group', `SELECT id, name FROM "group" WHERE id = ANY($1::int[])`), (r) => r.name);
    put(
      'stage',
      await query('stage', `SELECT s.id, s.name, c.name AS pipeline FROM deal_stage s LEFT JOIN collection c ON c.id = s.collection_id WHERE s.id = ANY($1::int[])`),
      (r) => r.name,
    );
    put('pipeline', await query('pipeline', `SELECT id, name FROM collection WHERE id = ANY($1::int[])`), (r) => r.name);
    put('company', await query('company', `SELECT id, name, deleted_at FROM company WHERE id = ANY($1::int[])`), (r) => `«${r.name}»`, (r) => !!r.deleted_at);
    put(
      'deal',
      await query('deal', `SELECT id, display_id, label, deleted_at FROM deal WHERE id = ANY($1::int[])`),
      (r) => `№${r.display_id ?? r.id}${r.label ? ` «${r.label}»` : ''}`,
      (r) => !!r.deleted_at,
    );
    put('product', await query('product', `SELECT id, name, deleted_at FROM product WHERE id = ANY($1::int[])`), (r) => `«${r.name}»`, (r) => !!r.deleted_at);
    put('filler', await query('filler', `SELECT id, field, target FROM filler WHERE id = ANY($1::int[])`), (r) => r.field);
    put('task_type', await query('task_type', `SELECT id, name FROM task_type WHERE id = ANY($1::int[])`), (r) => r.name);
    put('file', await query('file', `SELECT id, name FROM file WHERE id = ANY($1::int[])`), (r) => `«${r.name}»`);
    put(
      'trigger',
      await query('trigger', `SELECT t.id, t.type, s.name AS stage FROM "trigger" t LEFT JOIN deal_stage s ON s.id = t.deal_stage_id WHERE t.id = ANY($1::int[])`),
      (r) => triggerName(r.id, r.type, r.stage),
    );
    await this.fromJournal(db);
  }

  /** What is gone from its table is named by its last state in the journal. */
  private async fromJournal(db: DataSource | EntityManager): Promise<void> {
    const missing: { entity: string; id: number; kind: RefKind }[] = [];
    for (const [kind, set] of this.wanted) {
      for (const id of set) {
        if (this.values.has(`${kind}:${id}`)) continue;
        for (const entity of JOURNAL_ENTITIES[kind] ?? []) missing.push({ entity, id, kind });
      }
    }
    if (!missing.length) return;
    const rows: { entity: string; entity_id: string; state: any }[] = await db.query(
      `SELECT DISTINCT ON (entity, entity_id) entity, entity_id, COALESCE(before_state, after_state) AS state
         FROM audit_log
        WHERE (entity, entity_id) IN (SELECT * FROM unnest($1::varchar[], $2::bigint[]))
        ORDER BY entity, entity_id, id DESC`,
      [missing.map((m) => m.entity), missing.map((m) => m.id)],
    );
    for (const row of rows) {
      const wanted = missing.find((m) => m.entity === row.entity && m.id === Number(row.entity_id));
      if (!wanted || this.values.has(`${wanted.kind}:${wanted.id}`)) continue;
      const state = row.state ?? {};
      const name =
        wanted.kind === 'deal'
          ? `№${state.display_id ?? wanted.id}${state.label ? ` «${state.label}»` : ''}`
          : wanted.kind === 'user'
            ? state.username
            : wanted.kind === 'filler'
              ? state.field
              : wanted.kind === 'trigger'
                ? triggerName(wanted.id, state.type, null)
                : ['company', 'product', 'file'].includes(wanted.kind)
                  ? `«${state.name}»`
                  : state.name;
      if (name) this.values.set(`${wanted.kind}:${wanted.id}`, { name, deleted: true, extra: state });
    }
  }
}

const FALLBACK: Record<RefKind, string> = {
  user: 'пользователь',
  group: 'группа',
  stage: 'этап',
  pipeline: 'воронка',
  company: 'компания',
  deal: 'сделка',
  product: 'товар',
  filler: 'поле',
  task_type: 'тип',
  file: 'файл',
  trigger: 'триггер',
};

const JOURNAL_ENTITIES: Partial<Record<RefKind, string[]>> = {
  user: ['user', 'contact'],
  group: ['group'],
  stage: ['stage'],
  pipeline: ['pipeline'],
  company: ['company'],
  deal: ['deal'],
  product: ['product'],
  filler: ['filler'],
  task_type: ['task_type'],
  file: ['file'],
  trigger: ['trigger'],
};

const TRIGGER_WORDS: Record<string, string> = {
  '0': 'создать задачу',
  '1': 'создать сделку',
  '2': 'отправить письмо',
  '3': 'закрыть задачи',
  '4': 'сменить ответственного',
  '5': 'изменить поля',
  '6': 'удалить файлы',
  '7': 'перевести на этап',
  '8': 'уведомить',
};

function triggerName(id: unknown, type: unknown, stage: unknown): string {
  const what = TRIGGER_WORDS[String(type)];
  return `№${id}${what ? ` «${what}»` : ''}${stage ? ` · этап «${stage}»` : ''}`;
}

const asNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

type Row = AuditLog & { merged?: boolean };

export class AuditRenderer {
  constructor(private readonly db: DataSource | EntityManager) {}

  async render(rows: AuditLog[]): Promise<RenderedChange[]> {
    const merged = AuditRenderer.mergeReplaced(rows);
    const refs = new Refs();
    for (const row of merged) this.collect(row, refs);
    await refs.load(this.db);
    return merged.map((row) => this.renderRow(row, refs));
  }

  /**
   * A removal and an insertion of the same object (by its natural key) in one operation is one change
   * (MES: «удаление и вставка того же объекта одним сохранением показываются одной правкой»).
   */
  static mergeReplaced(rows: AuditLog[]): Row[] {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      if (row.action !== 'insert' && row.action !== 'delete') continue;
      const spec = specOfEntity(row.entity);
      const state = (row.action === 'insert' ? row.after_state : row.before_state) ?? {};
      const natural = spec?.naturalKey?.(state);
      if (!natural) continue;
      const key = `${row.batch}|${row.entity}|${natural}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const replaced = new Map<string, Row | null>();
    for (const group of groups.values()) {
      const removed = group.filter((r) => r.action === 'delete');
      const added = group.filter((r) => r.action === 'insert');
      if (removed.length !== 1 || added.length !== 1) continue;
      const spec = specOfEntity(added[0].entity);
      const changes = AuditJournal.diff(spec, { ...removed[0].before_state, id: null }, { ...added[0].after_state, id: null });
      const update: Row = Object.assign(new AuditLog(), added[0], {
        action: 'update',
        changes,
        before_state: removed[0].before_state,
        merged: true,
      });
      replaced.set(String(added[0].id), Object.keys(changes).length ? update : null);
      replaced.set(String(removed[0].id), null);
    }
    const out: Row[] = [];
    for (const row of rows) {
      const key = String(row.id);
      if (!replaced.has(key)) out.push(row);
      else if (replaced.get(key)) out.push(replaced.get(key));
    }
    return out;
  }

  private collect(row: Row, refs: Refs): void {
    const spec = specOfEntity(row.entity);
    const state: any = row.after_state ?? row.before_state ?? {};
    const sourceRef = /^trigger:(\d+)$/.exec(row.source_ref ?? '');
    if (sourceRef) refs.want('trigger', sourceRef[1]);
    if (row.actor_id) refs.want('user', row.actor_id);
    switch (row.entity) {
      case 'deal_product':
        refs.want('deal', state.deal_id);
        refs.want('product', state.product_id);
        break;
      case 'deal_filler':
        refs.want('deal', state.deal_id);
        refs.want('filler', state.filler_id);
        break;
      case 'company_filler':
        refs.want('company', state.company_id);
        refs.want('filler', state.filler_id);
        break;
      case 'user_filler':
        refs.want('user', state.user_id);
        refs.want('filler', state.filler_id);
        break;
      case 'product_filler':
        refs.want('product', state.product_id);
        refs.want('filler', state.filler_id);
        break;
      case 'stage':
        refs.want('pipeline', state.collection_id);
        break;
      case 'trigger':
        refs.want('stage', state.deal_stage_id);
        break;
      case 'comment':
      case 'file_link':
        refs.want('deal', row.deal_id ?? state.deal_id);
        refs.want('company', row.company_id);
        refs.want('user', row.contact_id);
        break;
      case 'auth':
      case 'bot_account':
      case 'messenger':
        refs.want('user', row.entity_id);
        break;
      case 'recorder_token':
      case 'mailbox':
        refs.want('user', state.user_id);
        break;
    }
    for (const [field, pair] of Object.entries(row.changes ?? {})) {
      const ref = spec?.fields[field]?.ref;
      if (!ref || !Array.isArray(pair)) continue;
      refs.want(ref, pair[0]);
      refs.want(ref, pair[1]);
    }
  }

  private renderRow(row: Row, refs: Refs): RenderedChange {
    const spec = specOfEntity(row.entity);
    const state: any = row.after_state ?? row.before_state ?? {};
    // a failed login has no author: somebody typed an e-mail (shown among the attributes)
    const unknown = row.action === 'login_failed' && !row.actor_id;
    const automation = !row.actor_id && !row.actor_name && !unknown;
    const triggerRef = /^trigger:(\d+)$/.exec(row.source_ref ?? '');
    const sourceText =
      row.source === 'trigger' && triggerRef ? `Триггер ${refs.name('trigger', triggerRef[1])}` : automation ? AUTOMATION_NAME[row.source] ?? null : null;
    const actorUser = row.actor_id ? refs.get('user', row.actor_id) : undefined;
    const actorName = unknown
      ? 'Неизвестный'
      : automation
        ? sourceText ?? AUTOMATION_NAME[row.source] ?? 'Система'
        : row.actor_name ?? actorUser?.name ?? `пользователь №${row.actor_id}`;
    const causedBy = (row.meta as any)?.caused_by?.name ?? null;
    return {
      kind: 'change',
      id: String(row.id),
      at: new Date(row.at).toISOString(),
      batch: row.batch,
      request_id: row.request_id ?? null,
      actor: { id: row.actor_id ?? null, name: actorName, deleted: !!actorUser?.deleted, automation },
      source: row.source,
      // web has no label (null in SOURCE_LABEL): `?? row.source` would show «web» on every change of a person
      source_label: row.source in SOURCE_LABEL ? SOURCE_LABEL[row.source] : row.source ?? null,
      source_text: sourceText,
      caused_by: causedBy,
      action: row.action,
      action_text: this.actionText(row),
      entity: row.entity,
      entity_text: entityName(row.entity),
      entity_id: row.entity_id ?? null,
      object: this.objectOf(row, spec, state, refs),
      link: this.linkOf(row, state),
      deal_id: row.deal_id ?? null,
      company_id: row.company_id ?? null,
      contact_id: row.contact_id ?? null,
      fields: this.fieldsOf(row, spec, refs),
      summary: row.summary ?? null,
    };
  }

  private actionText(row: Row): string {
    if (row.entity === 'file_link') return row.action === 'insert' ? 'Файл прикреплён' : 'Файл убран из сделки';
    if (row.entity === 'auth' && row.action === 'logout' && (row.meta as any)?.everywhere) return 'Выход на всех устройствах';
    if (row.entity === 'messenger') return row.action === 'delete' ? 'Отключение' : 'Подключение';
    if (row.entity === 'bot_account' && (row.action === 'insert' || row.action === 'delete')) {
      return row.action === 'insert' ? 'Подключение' : 'Отключение';
    }
    if (row.entity === 'task' && row.action === 'update') {
      const closed = row.changes?.closed_at;
      if (closed && !closed[0] && closed[1]) return 'Задача выполнена';
      if (closed && closed[0] && !closed[1]) return 'Задача возвращена в работу';
    }
    return ACTION_TEXT[row.action] ?? row.action;
  }

  private objectOf(row: Row, spec: EntitySpec | undefined, state: any, refs: Refs): string {
    const parentDeal = () => `Сделка ${refs.name('deal', state.deal_id ?? row.deal_id)}`;
    switch (row.entity) {
      case 'deal':
        return `Сделка №${state.display_id ?? row.entity_id}${state.label ? ` «${state.label}»` : ''}`;
      case 'deal_product':
        return `${parentDeal()} · товар ${refs.name('product', state.product_id)}`;
      case 'deal_filler':
        return `${parentDeal()} · поле «${refs.name('filler', state.filler_id)}»`;
      case 'company_filler':
        return `Компания ${refs.name('company', state.company_id)} · поле «${refs.name('filler', state.filler_id)}»`;
      case 'user_filler':
        return `Контакт «${refs.name('user', state.user_id)}» · поле «${refs.name('filler', state.filler_id)}»`;
      case 'product_filler':
        return `Товар ${refs.name('product', state.product_id)} · поле «${refs.name('filler', state.filler_id)}»`;
      case 'stage':
        return `Этап «${state.name ?? row.entity_id}»${state.collection_id ? ` · воронка «${refs.name('pipeline', state.collection_id)}»` : ''}`;
      case 'trigger':
        return `Триггер ${triggerName(row.entity_id, state.type, state.deal_stage_id ? refs.name('stage', state.deal_stage_id) : null)}`;
      case 'comment': {
        const where = row.deal_id
          ? `сделка ${refs.name('deal', row.deal_id)}`
          : row.company_id
            ? `компания ${refs.name('company', row.company_id)}`
            : row.contact_id
              ? `контакт «${refs.name('user', row.contact_id)}»`
              : '';
        return `Примечание${where ? ` · ${where}` : ''}`;
      }
      case 'file_link':
        return `Файл${state.name ? ` «${state.name}»` : ` №${row.entity_id}`} · сделка ${refs.name('deal', row.deal_id)}`;
      case 'auth': {
        if (row.entity_id) return `Сотрудник «${refs.name('user', row.entity_id)}»`;
        const email = (row.meta as any)?.email;
        return email ? `Вход под «${email}»` : 'Вход в CRM';
      }
      case 'bot_account':
        return `Telegram-бот CRM · сотрудник «${refs.name('user', row.entity_id)}»`;
      case 'messenger': {
        const channel = (row.meta as any)?.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram';
        return `${channel} · сотрудник «${refs.name('user', row.entity_id)}»`;
      }
      case 'recorder_token':
        return `Токен записи звонков · сотрудник «${refs.name('user', state.user_id)}»`;
      case 'mailbox':
        return `Почтовый ящик ${state.email ?? ''}`.trim();
      case 'setting':
        return 'Общие настройки';
      default:
        return spec ? spec.title(state, row.entity) : entityName(row.entity);
    }
  }

  /** Where the object is in the web client. */
  private linkOf(row: Row, state: any): string | null {
    const id = asNumber(row.entity_id);
    switch (row.entity) {
      case 'deal':
        return id ? `/deals/${id}` : null;
      case 'deal_product':
      case 'deal_filler':
      case 'file_link':
      case 'file':
        return row.deal_id ? `/deals/${row.deal_id}` : null;
      case 'comment':
        return row.deal_id
          ? `/deals/${row.deal_id}`
          : row.company_id
            ? `/lists/companies/${row.company_id}`
            : row.contact_id
              ? `/lists/contacts/${row.contact_id}`
              : null;
      case 'company':
        return id ? `/lists/companies/${id}` : null;
      case 'company_filler':
        return asNumber(state.company_id) ? `/lists/companies/${state.company_id}` : null;
      case 'contact':
        return id ? `/lists/contacts/${id}` : null;
      case 'user_filler':
        return asNumber(state.user_id) ? `/lists/contacts/${state.user_id}` : null;
      case 'user':
      case 'auth':
      case 'bot_account':
      case 'messenger':
        return id ? `/settings/users/${id}` : null;
      case 'recorder_token':
        return '/settings/calls';
      case 'task':
        return id ? `/tasks?id=${id}` : null;
      case 'product':
        return id ? `/lists/products/${id}` : null;
      case 'product_filler':
        return asNumber(state.product_id) ? `/lists/products/${state.product_id}` : null;
      case 'trigger':
      case 'stage':
      case 'pipeline':
      case 'setting':
        return '/settings/deals';
      case 'group':
        return id ? `/settings/groups/${id}` : null;
      case 'mail_template':
      case 'mailbox':
        return '/mails/settings';
      default:
        return null;
    }
  }

  private fieldsOf(row: Row, spec: EntitySpec | undefined, refs: Refs): RenderedField[] {
    if (['login', 'logout', 'login_failed'].includes(row.action) || row.entity === 'messenger') return this.loginFields(row);
    if (!spec) return [];
    const changes = row.changes ?? {};
    const state: any = row.after_state ?? row.before_state ?? {};
    const fillerLabel = ['deal_filler', 'company_filler', 'user_filler', 'product_filler'].includes(row.entity)
      ? refs.name('filler', state.filler_id)
      : null;
    // inserted, removed and baseline objects: their values (no empty ones); changes: the changed attributes
    const whole = ['insert', 'delete', 'baseline'].includes(row.action);
    const removed = row.action === 'delete';
    const values: Record<string, [unknown, unknown]> =
      whole && !Object.keys(changes).length
        ? Object.fromEntries(
            Object.entries((removed ? row.before_state : row.after_state) ?? {}).map(([k, v]) => [k, removed ? [v, null] : [null, v]]),
          )
        : changes;
    const order = [
      ...Object.keys(spec.fields).filter((key) => key in values),
      ...(whole ? [] : Object.keys(values).filter((key) => !(key in spec.fields))),
    ];
    const out: RenderedField[] = [];
    for (const key of order) {
      if (key === spec.pk || key === spec.softDelete || isQuiet(spec, key)) continue;
      const pair = values[key];
      if (!Array.isArray(pair)) continue;
      const [was, now] = pair;
      const field = spec.fields[key];
      const label = fillerLabel && key === 'value' ? fillerLabel : field?.label ?? key;
      // the number of a deal is in its title
      if (whole && row.entity === 'deal' && key === 'display_id') continue;
      if (field?.kind === 'permissions') {
        out.push(...this.permissionFields(was, now, whole));
        continue;
      }
      if (field?.kind === 'objectives') {
        out.push(...this.objectiveFields(field.label, whole && removed ? null : was, whole && removed ? null : now));
        continue;
      }
      if (isSecret(spec, key)) {
        // only that it is set or changed, never a value
        if (removed || row.action === 'baseline') continue;
        if (whole) {
          if (now !== null && now !== undefined) out.push({ field: key, label, before: null, after: 'задан' });
          continue;
        }
        out.push({
          field: key,
          label,
          before: null,
          after: was === null || was === undefined ? 'задан' : now === null || now === undefined ? 'удалён' : 'изменён',
          single: true,
        });
        continue;
      }
      if (!whole && (field?.kind === 'json' || field?.kind === 'image')) {
        const empty = (v: unknown) => v === null || v === undefined || v === '';
        const text = empty(was) ? 'добавлено' : empty(now) ? 'удалено' : 'изменено';
        out.push({ field: key, label, before: null, after: text, single: true });
        continue;
      }
      const before = whole && !removed ? null : this.show(field, was, refs);
      const after = whole && removed ? null : this.show(field, now, refs);
      if (whole && before === null && after === null) continue;
      if (!whole && before === after) continue;
      out.push({ field: key, label, before, after, delta: whole ? null : this.delta(field, was, now, refs) });
    }
    return out;
  }

  private show(field: FieldSpec | undefined, value: unknown, refs: Refs): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (field?.words) return field.words[String(value)] ?? String(value);
    if (field?.ref) {
      if (Array.isArray(value)) return value.length ? value.map((id) => refs.name(field.ref, id)).join(', ') : null;
      return refs.name(field.ref, value);
    }
    switch (field?.kind) {
      case 'money':
        return formatMoney(value);
      case 'number':
        return formatNumber(value);
      case 'bytes':
        return formatBytes(value);
      case 'datetime':
      case 'date':
        return formatDateTime(value);
      case 'bool':
        return value === true || value === 'true' || value === 1 ? 'да' : 'нет';
      case 'image':
        return 'есть';
      case 'json':
        return 'задано';
      case 'list':
        return Array.isArray(value) ? value.join(', ') : String(value);
    }
    if (typeof value === 'boolean') return value ? 'да' : 'нет';
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 200);
    return String(value);
  }

  private delta(field: FieldSpec | undefined, before: unknown, after: unknown, refs: Refs): string | null {
    if ((field?.kind === 'money' || field?.kind === 'number') && before !== null && after !== null) {
      const a = Number(before);
      const b = Number(after);
      if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && a !== b) {
        return `${b > a ? '+' : '−'}${formatNumber(Math.abs(b - a), field.kind === 'money' ? 2 : 3)}`;
      }
    }
    if (field?.kind === 'list' && field.ref && (Array.isArray(before) || Array.isArray(after))) {
      const was = new Set((Array.isArray(before) ? before : []).map(Number));
      const now = new Set((Array.isArray(after) ? after : []).map(Number));
      const added = [...now].filter((id) => !was.has(id)).map((id) => refs.name(field.ref, id));
      const removed = [...was].filter((id) => !now.has(id)).map((id) => refs.name(field.ref, id));
      const parts = [];
      if (added.length) parts.push(`добавлен${added.length > 1 ? 'ы' : ''}: ${added.join(', ')}`);
      if (removed.length) parts.push(`убран${removed.length > 1 ? 'ы' : ''}: ${removed.join(', ')}`);
      return parts.length ? parts.join('; ') : null;
    }
    if (field?.kind === 'json' && before !== null && after !== null) return 'изменено';
    return null;
  }

  /** Rights by entity and action: «Права · Сделки — просмотр: свои → все». */
  private permissionFields(before: any, after: any, whole: boolean): RenderedField[] {
    const level = (value: unknown) => (value === null || value === undefined ? null : LEVELS[String(value)] ?? String(value));
    const flag = (value: unknown) => (value === null || value === undefined ? null : value === false ? 'нет' : 'да');
    if (whole) {
      const state = (after ?? before) as any;
      if (!state || typeof state !== 'object') return [];
      const parts = Object.entries(PERMISSION_ENTITIES)
        .filter(([key]) => state[key] && state[key].view !== undefined)
        .map(([key, name]) => `${name.toLowerCase()} — ${level(state[key].view)}`);
      if (state.mail !== undefined) parts.push(`почта — ${flag(state.mail)}`);
      if (state.file !== undefined) parts.push(`файлы — ${flag(state.file)}`);
      const text = parts.join(', ') || null;
      return text ? [{ field: 'permissions', label: 'Права', before: after ? null : text, after: after ? text : null }] : [];
    }
    const out: RenderedField[] = [];
    const was = before && typeof before === 'object' ? before : {};
    const now = after && typeof after === 'object' ? after : {};
    for (const [entity, name] of Object.entries(PERMISSION_ENTITIES)) {
      for (const [action, verb] of Object.entries(PERMISSION_ACTIONS)) {
        const a = was[entity]?.[action];
        const b = now[entity]?.[action];
        if ((a ?? null) === (b ?? null)) continue;
        out.push({ field: `permissions.${entity}.${action}`, label: `Права · ${name} — ${verb}`, before: level(a), after: level(b) });
      }
    }
    for (const [key, label] of [
      ['mail', 'Права · доступ к почте'],
      ['file', 'Права · доступ к файлам'],
    ]) {
      const a = was[key];
      const b = now[key];
      if ((a ?? null) !== (b ?? null)) out.push({ field: `permissions.${key}`, label, before: flag(a), after: flag(b) });
    }
    return out;
  }

  private objectiveFields(label: string, before: any, after: any): RenderedField[] {
    const out: RenderedField[] = [];
    const was = before && typeof before === 'object' ? before : {};
    const now = after && typeof after === 'object' ? after : {};
    for (const [key, name] of Object.entries(OBJECTIVES)) {
      const a = was[key] ?? null;
      const b = now[key] ?? null;
      if (a === b) continue;
      out.push({
        field: `objectives.${key}`,
        label: `${label} ${name}`,
        before: a === null ? null : formatMoney(a),
        after: b === null ? null : formatMoney(b),
      });
    }
    return out;
  }

  private loginFields(row: Row): RenderedField[] {
    const meta: any = row.meta ?? {};
    const out: RenderedField[] = [];
    if (meta.email) out.push({ field: 'email', label: 'E-mail', before: null, after: String(meta.email) });
    if (meta.reason) out.push({ field: 'reason', label: 'Причина', before: null, after: String(meta.reason) });
    if (meta.ip) out.push({ field: 'ip', label: 'Адрес', before: null, after: String(meta.ip) });
    const browser = browserOf(meta.user_agent);
    if (browser) out.push({ field: 'browser', label: 'Браузер', before: null, after: browser });
    if (meta.bot_unlinked) out.push({ field: 'bot', label: 'Telegram-бот CRM', before: null, after: 'отключён' });
    if (meta.phone) out.push({ field: 'phone', label: 'Номер', before: null, after: String(meta.phone) });
    if (meta.account) out.push({ field: 'account', label: 'Аккаунт', before: null, after: String(meta.account) });
    return out;
  }
}
