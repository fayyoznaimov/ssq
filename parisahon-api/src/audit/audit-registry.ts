/**
 * What the journal tracks and how it names it (the dictionary of the renderer, audit-render.ts).
 *
 * A tracked table has a spec: the key of the object in audit_log.entity, its Russian name, the
 * attributes shown with their Russian labels and kinds (a reference to resolve, a sum, a date…),
 * secrets that are never stored (only that they changed), quiet service columns (a change of only
 * those makes no row and they are not shown: who and when stand in the head of the operation), long
 * texts kept shortened, and which deal / company / contact a row belongs to (the histories of the cards).
 *
 * The journal keeps rows by their database columns (SELECT * of the row), as the MES journal does.
 */

export type RefKind =
  | 'user'
  | 'group'
  | 'stage'
  | 'pipeline'
  | 'company'
  | 'deal'
  | 'product'
  | 'filler'
  | 'task_type'
  | 'file'
  | 'trigger';

export type ValueKind =
  | 'text'
  | 'money'
  | 'number'
  | 'bytes'
  | 'datetime'
  | 'date'
  | 'bool'
  | 'json'
  | 'permissions'
  | 'objectives'
  | 'list'
  | 'image';

export interface FieldSpec {
  label: string;
  kind?: ValueKind;
  ref?: RefKind;
  words?: Record<string, string>;
}

export type AuditGroup = 'data' | 'settings' | 'access';

export interface RowLinks {
  deal?: number | null;
  company?: number | null;
  contact?: number | null;
}

export interface EntitySpec {
  /** the database table */
  table: string;
  /** audit_log.entity */
  key: string;
  /** what the object is: «Сделка», «Компания» */
  name: string;
  group: AuditGroup;
  pk: string;
  /** shown attributes, in this order; columns not listed are kept in the states but not shown */
  fields: Record<string, FieldSpec>;
  /** never stored: only «изменён» (passwords, hashes, tokens, signatures) */
  secret?: string[];
  /** service columns: not shown, a change of only these makes no row */
  quiet?: string[];
  /** long texts: kept shortened */
  long?: string[];
  /** the soft delete column: null → value is «в корзину / удалён», value → null «восстановлен» */
  softDelete?: string;
  /** extra columns of the state: `SELECT t.*, <extra> FROM <table> t` */
  extra?: string;
  /** only these rows of the table are read (SQL on `t`): the comments among all history entries */
  scope?: string;
  /** the object of a row may be another one than the table's (a staff account vs a contact) */
  entityOf?: (row: Record<string, any>) => string;
  /** only these rows are journaled (comments among all history entries) */
  accepts?: (row: Record<string, any>) => boolean;
  /** the state kept for a row, when it is not the row itself */
  project?: (row: Record<string, any>) => Record<string, any>;
  links: (row: Record<string, any>) => RowLinks;
  /** a title without lookups, for audit_log.summary; the renderer makes a better one */
  title: (row: Record<string, any>, entity: string) => string;
  /** the same object under another row id (a product deleted and added again in one save) */
  naturalKey?: (row: Record<string, any>) => string | null;
}

const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const quoted = (value: unknown): string => (value === null || value === undefined || value === '' ? '' : ` «${String(value)}»`);

/** Russian names of the values of enumerations */
export const WORDS = {
  role: { admin: 'администратор', manager: 'руководитель', agent: 'менеджер', ctr_agent: 'контакт клиента' } as Record<string, string>,
  stageKind: {
    new: 'неразобранное',
    first_contact: 'первичный контакт',
    prepayment: 'предоплата',
    won: 'успешно реализовано',
    lost: 'закрыто и не реализовано',
    work: 'рабочий',
  } as Record<string, string>,
  triggerType: {
    '0': 'создать задачу',
    '1': 'создать сделку',
    '2': 'отправить письмо',
    '3': 'закрыть задачи',
    '4': 'сменить ответственного',
    '5': 'изменить поля',
    '6': 'удалить файлы',
    '7': 'перевести на этап',
    '8': 'уведомить',
  } as Record<string, string>,
  applyWhen: {
    right_away: 'сразу при переходе на этап',
    at_exact_time: 'в указанное время',
    every_day: 'каждый день',
    every_week: 'каждую неделю',
    every_month: 'каждый месяц',
    every_year: 'каждый год',
    email_received: 'при письме клиента',
    tg_message_received: 'при сообщении в Telegram',
    wa_message_received: 'при сообщении в WhatsApp',
    call_recorded: 'при звонке',
    no_reply: 'если клиенту не ответили',
  } as Record<string, string>,
  fileFrom: {
    from_messages: 'из сообщения',
    from_emails: 'из письма',
    uploaded_from_files_tab: 'загружен во вкладке «Файлы»',
    from_comments: 'из примечания',
  } as Record<string, string>,
  fillerTarget: { company: 'компании', deal: 'сделки', user: 'контакты', product: 'товары' } as Record<string, string>,
};

/** Columns that look like secrets in any table: never stored, whatever the spec says. */
export const SECRET_PATTERN = /(^|_)(password|passwd|secret|token|hash|session|api_key|apikey|cookie|otp|signature)($|_)/i;

/** Columns that are quiet in any table. */
const COMMON_QUIET = ['updated_at', 'updated_by'];

const fillerSpec = (
  table: string,
  key: string,
  name: string,
  parent: string,
  links: (row: Record<string, any>) => RowLinks,
): EntitySpec => ({
  table,
  key,
  name,
  group: 'data',
  pk: 'id',
  // the label of `value` is the name of the field (filler_id), the renderer resolves it
  fields: { value: { label: 'Значение' } },
  quiet: ['created_at'],
  links,
  title: () => name,
  naturalKey: (row) => (row[parent] && row.filler_id ? `${row[parent]}:${row.filler_id}` : null),
});

export const SPECS: EntitySpec[] = [
  {
    table: 'deal',
    key: 'deal',
    name: 'Сделка',
    group: 'data',
    pk: 'id',
    fields: {
      label: { label: 'Название' },
      display_id: { label: 'Номер' },
      budget: { label: 'Бюджет', kind: 'money' },
      stage_id: { label: 'Этап', ref: 'stage' },
      agent_id: { label: 'Ответственный', ref: 'user' },
      company_id: { label: 'Компания', ref: 'company' },
      contacts: { label: 'Контакты', ref: 'user', kind: 'list' },
      closed_at: { label: 'Закрыта', kind: 'datetime' },
      lost_reason: { label: 'Причина проигрыша' },
      lost_comment: { label: 'Комментарий к проигрышу' },
      repeat_of_id: { label: 'Повторное обращение после сделки', ref: 'deal' },
    },
    quiet: ['last_stage_change', 'created_at', 'deleted_by'],
    long: ['lost_comment'],
    softDelete: 'deleted_at',
    extra: `ARRAY(SELECT du."userId" FROM deal_user du WHERE du."dealId" = t.id ORDER BY 1) AS contacts`,
    links: (row) => ({ deal: num(row.id), company: num(row.company_id) }),
    title: (row) => `Сделка №${row.display_id ?? row.id}${quoted(row.label)}`,
  },
  {
    table: 'deal_product',
    key: 'deal_product',
    name: 'Товар в сделке',
    group: 'data',
    pk: 'id',
    fields: {
      product_id: { label: 'Товар', ref: 'product' },
      quantity: { label: 'Количество', kind: 'number' },
      price: { label: 'Цена', kind: 'money' },
    },
    links: (row) => ({ deal: num(row.deal_id) }),
    title: () => 'Товар в сделке',
    naturalKey: (row) => (row.deal_id && row.product_id ? `${row.deal_id}:${row.product_id}` : null),
  },
  fillerSpec('deal_filler', 'deal_filler', 'Доп. поле сделки', 'deal_id', (row) => ({ deal: num(row.deal_id) })),
  {
    table: 'company',
    key: 'company',
    name: 'Компания',
    group: 'data',
    pk: 'id',
    fields: {
      name: { label: 'Название' },
      email: { label: 'E-mail' },
      phone: { label: 'Телефон' },
      is_old: { label: 'Старый клиент', kind: 'bool' },
      inn: { label: 'ИНН' },
      director: { label: 'Директор' },
      legal_address: { label: 'Юридический адрес' },
      bank_account: { label: 'Расчётный счёт' },
      bank_name: { label: 'Банк' },
      mfo: { label: 'МФО' },
      oked: { label: 'ОКЭД' },
      primary_contact_id: { label: 'Основной контакт', ref: 'user' },
    },
    quiet: ['created_at', 'created_by', 'deleted_by'],
    softDelete: 'deleted_at',
    links: (row) => ({ company: num(row.id) }),
    title: (row) => `Компания${quoted(row.name)}`,
  },
  fillerSpec('company_filler', 'company_filler', 'Доп. поле компании', 'company_id', (row) => ({ company: num(row.company_id) })),
  {
    table: 'user',
    key: 'user',
    name: 'Сотрудник',
    group: 'access',
    pk: 'id',
    fields: {
      username: { label: 'Имя' },
      email: { label: 'E-mail' },
      phone: { label: 'Телефон' },
      role: { label: 'Роль', words: WORDS.role },
      group_id: { label: 'Группа', ref: 'group' },
      company_id: { label: 'Компания', ref: 'company' },
      permissions: { label: 'Права', kind: 'permissions' },
      password: { label: 'Пароль' },
      tg_id: { label: 'Telegram' },
      wa_id: { label: 'WhatsApp' },
      avatar: { label: 'Фото', kind: 'image' },
      objectives: { label: 'Цели', kind: 'objectives' },
      tg_api_hash: { label: 'Ключ Telegram API' },
      tg_api_id: { label: 'Приложение Telegram API' },
      sign: { label: 'Подпись в письмах' },
    },
    secret: ['password', 'tg_api_hash', 'tg_api_id', 'sign', 'token_version'],
    // «выйти на всех устройствах» is a row of its own (logout), not a change of the account
    quiet: ['created_at', 'created_by', 'deleted_by', 'token_version'],
    softDelete: 'deleted_at',
    entityOf: (row) => (row.role === 'ctr_agent' ? 'contact' : 'user'),
    links: (row) => (row.role === 'ctr_agent' ? { contact: num(row.id), company: num(row.company_id) } : {}),
    title: (row, entity) => `${entity === 'contact' ? 'Контакт' : 'Сотрудник'}${quoted(row.username)}`,
  },
  fillerSpec('user_filler', 'user_filler', 'Доп. поле контакта', 'user_id', (row) => ({ contact: num(row.user_id) })),
  {
    table: 'task',
    key: 'task',
    name: 'Задача',
    group: 'data',
    pk: 'id',
    fields: {
      label: { label: 'Задача' },
      type_id: { label: 'Тип', ref: 'task_type' },
      start_time: { label: 'Начало', kind: 'datetime' },
      end_time: { label: 'Срок', kind: 'datetime' },
      allDay: { label: 'На весь день', kind: 'bool' },
      agent_id: { label: 'Исполнитель', ref: 'user' },
      group_id: { label: 'Группа', ref: 'group' },
      deal_id: { label: 'Сделка', ref: 'deal' },
      company_id: { label: 'Компания', ref: 'company' },
      ctr_agent_id: { label: 'Контакт', ref: 'user' },
      closed_at: { label: 'Выполнена', kind: 'datetime' },
      result: { label: 'Результат' },
    },
    quiet: ['created_at', 'createdById'],
    long: ['result'],
    links: (row) => ({ deal: num(row.deal_id), company: num(row.company_id), contact: num(row.ctr_agent_id) }),
    title: (row) => `Задача${quoted(row.label)}`,
  },
  {
    table: 'product',
    key: 'product',
    name: 'Товар',
    group: 'data',
    pk: 'id',
    fields: {
      name: { label: 'Название' },
      sku: { label: 'Артикул' },
      unit: { label: 'Единица' },
      price: { label: 'Цена', kind: 'money' },
    },
    quiet: ['created_at', 'created_by'],
    softDelete: 'deleted_at',
    links: () => ({}),
    title: (row) => `Товар${quoted(row.name)}`,
  },
  fillerSpec('product_filler', 'product_filler', 'Доп. поле товара', 'product_id', () => ({})),
  {
    table: 'file',
    key: 'file',
    name: 'Файл',
    group: 'data',
    pk: 'id',
    fields: {
      name: { label: 'Файл' },
      size: { label: 'Размер', kind: 'bytes' },
      from: { label: 'Откуда', words: WORDS.fileFrom },
      deals: { label: 'Сделки', ref: 'deal', kind: 'list' },
    },
    // the name of the file on the disk is a key to it (links are signed): never stored
    secret: ['path'],
    quiet: ['created_at', 'extension', 'uploaded_by', 'email_id'],
    extra: `ARRAY(SELECT df."dealId" FROM deal_file df WHERE df."fileId" = t.id ORDER BY 1) AS deals`,
    links: (row) => ({ deal: Array.isArray(row.deals) && row.deals.length ? num(row.deals[0]) : null }),
    title: (row) => `Файл${quoted(row.name)}`,
  },
  {
    table: 'event',
    key: 'comment',
    name: 'Примечание',
    group: 'data',
    pk: 'id',
    fields: {
      comment: { label: 'Текст' },
      deal_id: { label: 'Сделка', ref: 'deal' },
      company_id: { label: 'Компания', ref: 'company' },
      contact_id: { label: 'Контакт', ref: 'user' },
    },
    long: ['comment'],
    accepts: (row) => Number(row.type) === 5,
    scope: 't.type = 5',
    project: (row) => ({
      id: row.id,
      comment: row.after_state?.data?.comment ?? null,
      edited_at: row.after_state?.data?.edited_at ?? null,
      deal_id: row.deal_id ?? null,
      company_id: row.company_id ?? null,
      contact_id: row.contact_id ?? null,
      user_id: row.user_id ?? null,
    }),
    quiet: ['edited_at', 'user_id'],
    links: (row) => ({ deal: num(row.deal_id), company: num(row.company_id), contact: num(row.contact_id) }),
    title: () => 'Примечание',
  },
  {
    table: 'trigger',
    key: 'trigger',
    name: 'Триггер',
    group: 'settings',
    pk: 'id',
    fields: {
      type: { label: 'Действие', words: WORDS.triggerType },
      deal_stage_id: { label: 'Этап', ref: 'stage' },
      apply_when: { label: 'Когда', words: WORDS.applyWhen },
      is_delayed: { label: 'С задержкой', kind: 'bool' },
      is_recurring: { label: 'Повторять', kind: 'bool' },
      user_id: { label: 'Сотрудник', ref: 'user' },
      deal_filters: { label: 'Условия по сделке', kind: 'json' },
      apply_when_data: { label: 'Время срабатывания', kind: 'json' },
      data: { label: 'Параметры действия', kind: 'json' },
    },
    // the order of the triggers of a stage: moving one renumbers the others
    quiet: ['created_at', 'position'],
    links: () => ({}),
    title: (row) => `Триггер №${row.id}`,
  },
  {
    table: 'setting',
    key: 'setting',
    name: 'Общие настройки',
    group: 'settings',
    pk: 'id',
    fields: {
      default_stage_id: { label: 'Этап для новых сделок', ref: 'stage' },
      defaultAgentId: { label: 'Ответственный по умолчанию', ref: 'user' },
      mail_signature: { label: 'Подпись компании в письмах' },
    },
    // the signature of letters: only «изменена»
    secret: ['mail_signature'],
    links: () => ({}),
    title: () => 'Общие настройки',
  },
  {
    table: 'deal_stage',
    key: 'stage',
    name: 'Этап',
    group: 'settings',
    pk: 'id',
    fields: {
      name: { label: 'Название' },
      color: { label: 'Цвет' },
      kind: { label: 'Вид', words: WORDS.stageKind },
      collection_id: { label: 'Воронка', ref: 'pipeline' },
      description: { label: 'Описание' },
    },
    // the order of the columns of the kanban: moving one renumbers all
    quiet: ['created_at', 'order'],
    links: () => ({}),
    title: (row) => `Этап${quoted(row.name)}`,
  },
  {
    table: 'collection',
    key: 'pipeline',
    name: 'Воронка',
    group: 'settings',
    pk: 'id',
    fields: { name: { label: 'Название' }, is_active: { label: 'Активная', kind: 'bool' } },
    quiet: ['created_at'],
    links: () => ({}),
    title: (row) => `Воронка${quoted(row.name)}`,
  },
  {
    table: 'group',
    key: 'group',
    name: 'Группа',
    group: 'access',
    pk: 'id',
    fields: { name: { label: 'Название' }, objectives: { label: 'Цели', kind: 'objectives' } },
    quiet: ['created_at'],
    links: () => ({}),
    title: (row) => `Группа${quoted(row.name)}`,
  },
  {
    table: 'task_type',
    key: 'task_type',
    name: 'Тип задачи',
    group: 'settings',
    pk: 'id',
    fields: { name: { label: 'Название' } },
    links: () => ({}),
    title: (row) => `Тип задачи${quoted(row.name)}`,
  },
  {
    table: 'filler',
    key: 'filler',
    name: 'Доп. поле',
    group: 'settings',
    pk: 'id',
    fields: {
      field: { label: 'Название' },
      target: { label: 'Где', words: WORDS.fillerTarget },
      is_required: { label: 'Обязательное', kind: 'bool' },
    },
    quiet: ['created_at'],
    links: () => ({}),
    title: (row) => `Доп. поле${quoted(row.field)}`,
  },
  {
    table: 'email_template',
    key: 'mail_template',
    name: 'Шаблон письма',
    group: 'settings',
    pk: 'id',
    fields: { name: { label: 'Название' }, subject: { label: 'Тема' }, template_body: { label: 'Текст' } },
    quiet: ['created_by'],
    long: ['template_body'],
    links: () => ({}),
    title: (row) => `Шаблон письма${quoted(row.name)}`,
  },
  {
    table: 'email_transporter',
    key: 'mailbox',
    name: 'Почтовый ящик',
    group: 'settings',
    pk: 'id',
    fields: {
      email: { label: 'Ящик' },
      user_id: { label: 'Сотрудник', ref: 'user' },
      password: { label: 'Пароль' },
      verified_at: { label: 'Проверен', kind: 'datetime' },
    },
    secret: ['password'],
    quiet: ['created_at'],
    links: () => ({}),
    title: (row) => `Почтовый ящик${quoted(row.email)}`,
  },
  {
    table: 'recorder_token',
    key: 'recorder_token',
    name: 'Токен записи звонков',
    group: 'access',
    pk: 'id',
    fields: {
      user_id: { label: 'Сотрудник', ref: 'user' },
      token_hash: { label: 'Токен' },
      revoked_at: { label: 'Отозван', kind: 'datetime' },
      tls_required: { label: 'Только FTPS', kind: 'bool' },
    },
    secret: ['token_hash'],
    quiet: ['created_at', 'created_by', 'last_upload_at'],
    links: () => ({}),
    title: () => 'Токен записи звонков',
  },
  {
    table: 'bot_account',
    key: 'bot_account',
    name: 'Telegram-бот CRM',
    group: 'access',
    pk: 'user_id',
    fields: {
      user_id: { label: 'Сотрудник', ref: 'user' },
      tg_username: { label: 'Telegram' },
      chat_id: { label: 'Чат' },
    },
    quiet: ['digest_on', 'linked_at'],
    links: () => ({}),
    title: () => 'Telegram-бот CRM',
  },
];

/** Objects that are not tables: logins, the link of a file to a deal. */
export const VIRTUAL_ENTITIES: Record<string, { name: string; group: AuditGroup }> = {
  auth: { name: 'Вход в CRM', group: 'access' },
  file_link: { name: 'Файл в сделке', group: 'data' },
  contact: { name: 'Контакт', group: 'data' },
  messenger: { name: 'Telegram / WhatsApp сотрудника', group: 'access' },
};

const BY_TABLE = new Map(SPECS.map((spec) => [spec.table, spec]));
const BY_KEY = new Map<string, EntitySpec>();
for (const spec of SPECS) BY_KEY.set(spec.key, spec);
// a contact is a row of "user"
BY_KEY.set('contact', BY_TABLE.get('user'));

export function specOfTable(table: string | undefined | null): EntitySpec | undefined {
  return table ? BY_TABLE.get(table) : undefined;
}

export function specOfEntity(entity: string): EntitySpec | undefined {
  return BY_KEY.get(entity);
}

/** The Russian name of an object kind of audit_log.entity. */
export function entityName(entity: string): string {
  return VIRTUAL_ENTITIES[entity]?.name ?? BY_KEY.get(entity)?.name ?? entity;
}

export function isSecret(spec: EntitySpec | undefined, column: string): boolean {
  return !!spec?.secret?.includes(column) || SECRET_PATTERN.test(column);
}

export function isQuiet(spec: EntitySpec | undefined, column: string): boolean {
  return !!spec?.quiet?.includes(column) || COMMON_QUIET.includes(column);
}

/** Every journal object key, for the filters of the client. */
export function entityKeys(): string[] {
  return [...new Set([...SPECS.map((s) => s.key), 'contact', ...Object.keys(VIRTUAL_ENTITIES)])];
}
