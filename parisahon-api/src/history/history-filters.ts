import { SelectQueryBuilder } from 'typeorm';
import { EventTypes } from '../events/event.entity';

/**
 * The filters «Всё / Переписка / Звонки / Задачи / Изменения» and the search of a history feed
 * (DEAL-10): the deal, the company, the contact and the whole client read the same rules
 * (EventsService.applyEventFilters calls applyHistoryFilters with `kind` and `q` of SearchEventDto).
 */
export const HISTORY_KINDS = ['all', 'messages', 'calls', 'tasks', 'changes'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** Which event types a filter shows. «Переписка»: what people wrote — the client's channels, notes, the inner chat. */
export const HISTORY_KIND_TYPES: Record<Exclude<HistoryKind, 'all'>, EventTypes[]> = {
  messages: [
    EventTypes.NEW_EMAIL,
    EventTypes.NEW_SMS,
    EventTypes.NEW_TELEGRAM_MESSAGE,
    EventTypes.NEW_WHATSAPP_MESSAGE,
    EventTypes.NEW_COMMENT,
    EventTypes.NEW_CHAT_MESSAGE,
  ],
  calls: [EventTypes.NEW_CALL_RECORDING, EventTypes.NEW_TELEGRAM_CALL],
  tasks: [EventTypes.NEW_TASK, EventTypes.NEW_TASK_STATUS, EventTypes.NEW_TASK_UPDATE],
  changes: [
    EventTypes.NEW_DEAL,
    EventTypes.NEW_CTR_AGENT,
    EventTypes.NEW_COMPANY,
    EventTypes.NEW_FIELD_VALUE,
    EventTypes.NEW_UPDATED_FIELD_VALUE,
    EventTypes.NEW_PRODUCT,
    EventTypes.NEW_DEAL_STAGE,
    EventTypes.EVENT_MOVED,
  ],
};

/** The longest search text taken (the rest is cut). */
export const HISTORY_SEARCH_MAX = 100;

/**
 * The text of an event the search looks in: a message and its files, a note, a task and its result,
 * a field change, a stage, a product, a call. A letter (subject, text, sender) only for a user who may
 * read mail: for the others the history hides it (EventsService.hideMail), and a search by its words
 * would tell what it says.
 */
export function historySearchText(alias: string, canReadMail: boolean): string {
  const a = `${alias}.after_state`;
  const parts = [
    `${a}->>'message'`,
    `${a}->>'name'`,
    `${a}->>'number'`,
    `${a}->'data'->>'message'`,
    `${a}->'data'->>'text'`,
    `${a}->'data'->>'comment'`,
    `${a}->'data'->>'label'`,
    `${a}->'data'->>'result'`,
    `${a}->'data'->>'field'`,
    `${a}->'data'->>'new_value'`,
    `${a}->'data'->>'old_value'`,
    `${a}->'data'->>'comment_text'`,
    `${a}->'data'->>'name'`,
    `${a}->'data'->>'username'`,
    `${a}->'data'->'type'->>'name'`,
    `${a}->'data'->'stage'->>'name'`,
    `${a}->'data'->'product'->>'name'`,
    // the names of the files of a Telegram / WhatsApp message
    `(SELECT string_agg(hf->>'name', ' ') FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${a}->'files') = 'array' THEN ${a}->'files' ELSE '[]'::jsonb END) hf)`,
  ];
  const text = `concat_ws(' ', ${parts.join(', ')})`;
  if (!canReadMail) {
    return `(CASE WHEN ${alias}.type = ${EventTypes.NEW_EMAIL} THEN '' ELSE ${text} END)`;
  }
  const mail = `concat_ws(' ', ${a}->'data'->>'subject', ${a}->'data'->>'body', ${a}->'data'->>'from')`;
  return `(CASE WHEN ${alias}.type = ${EventTypes.NEW_EMAIL} THEN ${mail} ELSE ${text} END)`;
}

/** `%` and `_` of the user's text are letters, not patterns. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Narrows a feed query (alias t0) to a filter and a search. `kind` other than the known ones and an
 * empty `q` change nothing. The author's or the addressee's name is searched too («Анна»).
 */
export function applyHistoryFilters<T>(
  qb: SelectQueryBuilder<T>,
  query: { kind?: string; q?: string },
  canReadMail = true,
): SelectQueryBuilder<T> {
  const kind = query?.kind as HistoryKind | undefined;
  if (kind && kind !== 'all' && HISTORY_KIND_TYPES[kind]) {
    qb = qb.andWhere('t0.type IN (:...history_kind_types)', { history_kind_types: HISTORY_KIND_TYPES[kind] });
  }
  const q = String(query?.q ?? '').trim().slice(0, HISTORY_SEARCH_MAX);
  if (q.length >= 2) {
    qb = qb.andWhere(
      `(${historySearchText('t0', canReadMail)} ILIKE :history_q
        OR EXISTS (SELECT 1 FROM "user" hsu WHERE hsu.id IN (t0.user_id, t0.target_user_id) AND hsu.username ILIKE :history_q))`,
      { history_q: likePattern(q) },
    );
  }
  return qb;
}
