import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { Event, EventTypes } from './event.entity';

/** A positive int id of a JSON snapshot, else null. */
function idOf(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[0-9]{1,9}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

const TASK_TYPES = [EventTypes.NEW_TASK, EventTypes.NEW_TASK_STATUS, EventTypes.NEW_TASK_UPDATE];

/**
 * The contact and the company an event names in its snapshot: the contact added to a deal, the
 * company added to a deal, the contact and company a task is linked to.
 */
export function clientOfSnapshot(type: EventTypes, afterState: any): { contact: number | null; company: number | null } {
  const data = afterState?.data;
  if (!data || typeof data !== 'object') return { contact: null, company: null };
  if (type === EventTypes.NEW_CTR_AGENT) return { contact: idOf(data.id), company: idOf(data.company?.id) };
  if (type === EventTypes.NEW_COMPANY) return { contact: null, company: idOf(data.id) };
  if (TASK_TYPES.includes(type)) return { contact: idOf(data.ctr_agent?.id), company: idOf(data.company?.id) };
  return { contact: null, company: null };
}

/**
 * Fills event.company_id and event.contact_id (DB-9) of a new history entry, whoever writes it (the
 * listener, the Telegram / WhatsApp inboxes, calls, triggers, notes): the client feeds query these
 * columns. What the writer set stays; otherwise
 *  - contact: the contact the snapshot names (added to the deal, the task's contact), the task's
 *    contact, the client among the author and the addressee (a message, a call, a change of a card);
 *  - company: the one the writer set, the deal's company, the task's company, the one the snapshot
 *    names, the contact's company.
 * Every id is checked against its table first: a snapshot pointing to a deleted row must not make
 * the insert fail on the foreign key. Migration 1795610000000-event-client applies the same rules to
 * the rows written before.
 */
@Injectable()
export class EventClientSubscriber implements EntitySubscriberInterface<Event> {
  constructor(dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return Event;
  }

  async beforeInsert(e: InsertEvent<Event>): Promise<void> {
    if (e.entity) await EventClientSubscriber.fill(e.manager, e.entity);
  }

  static async fill(manager: EntityManager, event: Event): Promise<void> {
    const explicitCompany = idOf(event.company?.id ?? event.company_id);
    const explicitContact = idOf(event.contact?.id ?? event.contact_id);
    if (explicitCompany && explicitContact) return;

    const snapshot = clientOfSnapshot(event.type, event.after_state);
    const dealId = idOf(event.deal?.id);
    const taskId = idOf(event.task?.id);
    const people = [idOf(event.originated_by?.id), idOf(event.target_user?.id)].filter((id): id is number => !!id);
    const wantedContact = explicitContact ?? snapshot.contact;
    const wantedCompany = explicitCompany ?? null;
    if (!wantedContact && !wantedCompany && !snapshot.company && !dealId && !taskId && !people.length) return;

    const row = (
      await manager.query(
        `WITH c AS (
           SELECT COALESCE(
             (SELECT u.id FROM "user" u WHERE u.id = $4 AND u.role = 'ctr_agent'),
             (SELECT t.ctr_agent_id FROM task t WHERE t.id = $2),
             (SELECT u.id FROM "user" u
               WHERE u.id = ANY($3::int[]) AND u.role = 'ctr_agent'
               ORDER BY array_position($3::int[], u.id) LIMIT 1)
           ) AS contact_id
         )
         SELECT c.contact_id,
                COALESCE(
                  (SELECT co.id FROM company co WHERE co.id = $5),
                  (SELECT d.company_id FROM deal d WHERE d.id = $1),
                  (SELECT t.company_id FROM task t WHERE t.id = $2),
                  (SELECT co.id FROM company co WHERE co.id = $6),
                  (SELECT u.company_id FROM "user" u WHERE u.id = c.contact_id)
                ) AS company_id
           FROM c`,
        [dealId, taskId, people, wantedContact, wantedCompany, snapshot.company],
      )
    )[0];
    if (!explicitContact && row?.contact_id) event.contact_id = Number(row.contact_id);
    if (!explicitCompany && row?.company_id) event.company_id = Number(row.company_id);
  }
}
