import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Access } from '../auth/access';
import { AuthGuard, AuthUser } from '../auth/auth.guard';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { HelperService } from '../helper/helper.service';
import { LoggerService } from '../helper/logger.service';
import { RoleEnum, User } from '../user/user.entity';
import { FetchEmailToDto } from './dto/fetch.email.to.dto';
import { SearchEmailDto } from './dto/search.email.dto';
import { Email } from './email.entity';
import { EmailTo } from './email_to.entity';
import { EmailTransporter } from './email.transporter.entity';
import { MailConnectionService } from './mail-connection.service';
import { addressesIn } from './mail-text';

/** A deal whose history a letter is in, as the mail list shows it. */
export interface LetterDeal {
  id: number;
  label: string;
  display_id: number;
  stage: string | null;
  stage_color: string | null;
  closed: boolean;
}

/** Who a letter is with: the contact and / or the company of the sender (received) or the recipients (sent). */
export interface LetterClient {
  contact: { id: number; username: string } | null;
  company: { id: number; name: string } | null;
}

/** NEW_EMAIL entries of the letter `t0` in deals that are not in the trash (SQL, for EXISTS). */
const IN_DEALS = `SELECT 1 FROM event eh JOIN deal dh ON dh.id = eh.deal_id AND dh.deleted_at IS NULL
  WHERE eh.type = 9 AND (eh.after_state -> 'data') ->> 'id' = t0.id::text`;

/**
 * A letter of a client: it is in a deal, or its sender is a contact or the address of a company.
 * «Неразобранные» are the others (newsletters, a new client's first letter): «Привязать» them.
 */
const OF_CLIENT = `(EXISTS (${IN_DEALS})
  OR EXISTS (SELECT 1 FROM "user" cu WHERE cu.id = t0.user_id AND cu.role = 'ctr_agent')
  OR EXISTS (SELECT 1 FROM company cc WHERE cc.deleted_at IS NULL AND lower(cc.email) = lower(t0.from)))`;

/** «Прочитано» for the user `:reader` (email_read); letters we sent are read. */
const READ_BY = `(t0.outgoing = true OR EXISTS (SELECT 1 FROM email_read er WHERE er.email_id = t0.id AND er.user_id = :reader))`;

/**
 * The stored emails as the staff work with them: list, open (marks read),
 * spam, delete. Admin and manager see every email, an agent the emails of their own
 * mailboxes (their address, a mailbox the mail server accepted the password of), the replies
 * to letters they sent and the letters of the deals they are responsible for.
 */
@Injectable()
export class MailboxService {
  constructor(
    @InjectRepository(Email)
    private emailRepository: Repository<Email>,
    @InjectRepository(EmailTo)
    private emailToRepository: Repository<EmailTo>,
    @InjectRepository(EmailTransporter)
    private emailTransporterRepository: Repository<EmailTransporter>,
    private dataSource: DataSource,
    private connection: MailConnectionService,
    private helperService: HelperService,
    private loggerService: LoggerService,
  ) {}

  async fetchLocalEmails(
    query: SearchEmailDto,
    user: User = null,
    authUser: AuthUser = null,
  ): Promise<PaginationResponseDto<Email[]>> {
    const qb = this.emailRepository.createQueryBuilder('t0');
    const relations = ['to', 'cc', 'from_user'];

    // An agent sees only the emails of their own mailboxes; admin and manager see all.
    if (user && user.role == RoleEnum.AGENT) {
      const own = await this.ownAddresses(user);
      qb.leftJoin('t0.to', 't4')
        .leftJoin('t0.cc', 't5')
        .andWhere(
          `(t0.sent_by_id = :user_id OR LOWER(t0.from) IN (:...own) OR t4.value ~* :own_re OR t5.value ~* :own_re
            OR t0.in_reply_to IN (SELECT o.message_id FROM email o WHERE o.sent_by_id = :user_id AND o.message_id IS NOT NULL)
            OR EXISTS (${IN_DEALS} AND dh.agent_id = :user_id))`,
          {
            user_id: user.id,
            // IN () is a syntax error; the pattern never matches an empty list
            own: own.length ? own : [''],
            own_re: addressPattern(own),
          },
        );
    }

    // a manager's mailbox: the letters with the address among To (one row per address now; older
    // rows with several addresses are matched inside the header)
    if (user && AuthGuard.MANAGER_LEVEL.includes(user.role) && query.email_to) {
      const address = addressesIn([query.email_to])[0] ?? query.email_to.trim().toLowerCase();
      qb.andWhere('EXISTS (SELECT 1 FROM email_to t6 WHERE t6.email_id = t0.id AND t6.value ~* :email_to_re)', {
        email_to_re: addressPattern([address]),
      });
    }

    if (query.from) {
      qb.andWhere('t0.from ILIKE :from', { from: `%${query.from}%` });
    }

    if (query.subject) {
      qb.andWhere('t0.subject ILIKE :subject', {
        subject: `%${query.subject}%`,
      });
    }

    if (query.deleted?.toLowerCase() === 'true') {
      // «Удалённые»: what was deleted in the CRM or lies in the Trash mailbox
      qb.withDeleted().andWhere('t0.deleted_at IS NOT NULL');
    } else if (query.is_spam?.toLowerCase() === 'true') {
      qb.andWhere('t0.is_spam = true');
    } else {
      qb.andWhere('t0.is_spam = false');
    }

    // The deals of a letter are the deals whose history it is in (it used to be the deals of the
    // sender's contact, closed ones too, and never for letters we sent)
    if (query.deal_label) {
      qb.andWhere(`EXISTS (${IN_DEALS} AND dh.label ILIKE :deal_label)`, {
        deal_label: `%${query.deal_label}%`,
      });
    }

    if (query.with_deal?.toLowerCase() === 'true') {
      qb.andWhere(`EXISTS (${IN_DEALS})`);
    }

    if (query.with_deal?.toLowerCase() === 'false') {
      qb.andWhere(`NOT EXISTS (${IN_DEALS})`);
    }

    // «От клиентов» / «Неразобранные» (no deal, the sender is no contact or company)
    if (query.of_client?.toLowerCase() === 'true') {
      qb.andWhere(OF_CLIENT);
    } else if (query.of_client?.toLowerCase() === 'false') {
      qb.andWhere(`NOT ${OF_CLIENT}`);
    }

    if (query.stages?.length) {
      qb.andWhere(`EXISTS (${IN_DEALS} AND dh.stage_id IN (:...stage_ids))`, {
        stage_ids: query.stages,
      });
    }

    if (query.from_date) {
      qb.andWhere('t0.sent_at >= :from_date', { from_date: query.from_date });
    }

    if (query.till_date) {
      qb.andWhere('t0.sent_at <= :till_date', { till_date: query.till_date });
    }

    if (query.with_attachments) {
      qb.leftJoinAndSelect('t0.files', 't3');

      if (query.with_attachments.toLowerCase() === 'true') {
        qb.andWhere('t3.id IS NOT NULL');
      }

      if (query.with_attachments.toLowerCase() === 'false') {
        qb.andWhere('t3.id IS NULL');
      }
    } else {
      relations.push('files');
    }

    if (query.read) {
      const read = query.read.toLowerCase() === 'true';
      if (user) qb.andWhere(`${READ_BY} = :read`, { reader: user.id, read });
      else qb.andWhere('t0.read = :read', { read });
    }

    if (query.outgoing) {
      qb.andWhere('t0.outgoing = :outgoing', {
        outgoing: query.outgoing.toLowerCase() === 'true',
      });
    }

    const page = await this.helperService.withPagination(
      this.helperService.withRelations(qb, relations, 't0', 6),
      query,
    );
    await this.describe(page.data ?? [], authUser ?? toAuthUser(user));
    await this.readFor(page.data ?? [], user);
    return page;
  }

  /** `read` of the letters as the user sees it: opened by them (email_read), or sent by us. */
  private async readFor(emails: Email[], user: User | null): Promise<void> {
    if (!user || !emails.length) return;
    const rows: { email_id: number }[] = await this.dataSource.query(
      `SELECT email_id FROM email_read WHERE user_id = $1 AND email_id = ANY($2)`,
      [user.id, emails.map((e) => e.id)],
    );
    const read = new Set(rows.map((row) => Number(row.email_id)));
    for (const email of emails) email.read = email.outgoing || read.has(email.id);
  }

  /** «Прочитано» for the user (the drawer, «Отметить как прочитанное», the letter opened in a deal). */
  async markRead(ids: number[], user: User): Promise<{ read: number }> {
    let read = 0;
    for (const id of [...new Set(ids.map(Number))]) {
      const email = await this.getAccessibleEmail(id, user);
      await this.readBy(email, user);
      read++;
    }
    return { read };
  }

  /** The user read the letter: their mark, and \Seen on the server (the flag of the shared mailbox). */
  private async readBy(email: Email, user: User): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO email_read (email_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [email.id, user.id],
    );
    if (email.email_id && email.read === false) {
      // The local copy is readable even when the mail server is not reachable,
      // so a failure to set \Seen there must not block opening the email.
      try {
        await this.connection.withMailbox(email.from_mailbox, (imap) =>
          // email_id is an IMAP UID, not a sequence number
          imap.messageFlagsAdd(`${email.email_id}`, ['\\Seen'], { uid: true }),
        );
      } catch (error) {
        this.loggerService.error('Error adding \\Seen flag:', error.stack);
      }
      await this.emailRepository.update(email.id, { read: true });
    }
  }

  async fetchOneLocalEmail(id: number, user: User, authUser: AuthUser = null): Promise<Email> {
    let email = await this.getAccessibleEmail(id, user, ['files']);

    // read by this user (it used to become read for everyone in Cc)
    await this.readBy(email, user);
    email.read = true;

    // The relation only served the access check
    delete email.sent_by;

    email.html = await this.htmlOf(email.id);
    await this.describe([email], authUser ?? toAuthUser(user));

    // whom a reply goes to: the sender, or for a letter we sent its recipients; «Ответить всем»
    // adds the others of To / Cc. Our own addresses (the shared mailbox, the user's) are left out.
    const ours = new Set(
      [...(await this.ownAddresses(user)), String(process.env.EMAIL_DEFAULT_USER ?? '').toLowerCase()].filter(Boolean),
    );
    const replyTo = (email.outgoing ? addressesIn((email.to ?? []).map((r) => r.value)) : addressesIn([email.from])).filter(
      (address) => !email.outgoing || !ours.has(address),
    );
    const others = addressesIn([...(email.to ?? []).map((r) => r.value), ...(email.cc ?? []).map((r) => r.value)]).filter(
      (address) => !ours.has(address) && !replyTo.includes(address),
    );
    (email as any).reply = { to: replyTo, cc_all: others };
    return email;
  }

  /**
   * Deletes a letter in the CRM: it is moved to the Trash mailbox of the server (it used to be
   * erased there for good, EXPUNGE) and hidden here; who and when stay on the row (deleted_by,
   * deleted_at). «Удалённые» shows it and «Восстановить» brings it back.
   */
  async deleteEmail(id: number, user: User): Promise<void> {
    const email = await this.getAccessibleEmail(id, user);
    // the letters of the shared mailbox are everybody's: an agent deletes only a letter they sent or
    // one written to them alone (an agent in Cc used to delete a client's letter for the whole department)
    if (!(await this.mayDelete(email, user))) {
      throw new ForbiddenException('Удалять письма общего ящика может только администратор или руководитель');
    }
    const trash = this.connection.mailboxes.trash;

    if (email.email_id && trash && email.from_mailbox !== trash) {
      try {
        await this.connection.withMailbox(email.from_mailbox, async (imap) => {
          const moved = await imap.messageMove(`${email.email_id}`, trash, { uid: true });
          if (!moved) {
            throw new BadRequestException('Почтовый сервер не переместил письмо в корзину');
          }
          const validity = moved.uidValidity ?? (await imap.status(trash, { uidValidity: true })).uidValidity;
          // without UIDPLUS the new uid is unknown: the next sync of Trash finds the row by Message-ID
          await this.emailRepository.update(email.id, {
            email_id: moved.uidMap?.get(+email.email_id) ?? null,
            from_mailbox: moved.destination ?? trash,
            uidvalidity: validity ? String(validity) : null,
          });
        });
      } catch (error) {
        this.loggerService.error(`Error deleting email ${id}`, error.stack);
        throw error;
      }
    }

    await this.emailRepository.update(email.id, { deleted_by: { id: user.id } as User });
    await this.emailRepository.softDelete(email.id);
    this.loggerService.log(`mail: letter ${email.id} "${email.subject ?? ''}" deleted by user ${user.id}`);
  }

  /**
   * May `user` delete the letter: an admin or a manager any; an agent a letter they sent, or one
   * written to them and to no colleague (not to the shared mailbox, not to other staff).
   */
  private async mayDelete(email: Email, user: User): Promise<boolean> {
    if (AuthGuard.MANAGER_LEVEL.includes(user.role)) return true;
    if (email.sent_by?.id === user.id) return true;
    const own = await this.ownAddresses(user);
    const recipients = addressesIn([...(email.to ?? []), ...(email.cc ?? [])].map((r) => r.value));
    if (!recipients.some((address) => own.includes(address))) return false;
    const others = recipients.filter((address) => !own.includes(address));
    if (!others.length) return true;
    const shared = String(process.env.EMAIL_DEFAULT_USER ?? '').trim().toLowerCase();
    if (shared && others.includes(shared)) return false;
    const staff = await this.dataSource.query(
      `SELECT 1 FROM "user" WHERE role <> 'ctr_agent' AND deleted_at IS NULL AND lower(email) = ANY($1) LIMIT 1`,
      [others],
    );
    return !staff.length;
  }

  /** «Восстановить»: a deleted letter goes back to INBOX (one we sent: to Sent) and is shown again. */
  async restoreEmail(id: number, user: User): Promise<void> {
    const email = await this.getAccessibleEmail(id, user, [], true);
    if (!email.deleted_at) return;
    const { inbox, sent } = this.connection.mailboxes;
    const target = email.outgoing ? sent : inbox;

    if (email.email_id && target && email.from_mailbox !== target) {
      await this.connection.withMailbox(email.from_mailbox, async (imap) => {
        const moved = await imap.messageMove(`${email.email_id}`, target, { uid: true });
        if (!moved) {
          throw new BadRequestException('Почтовый сервер не вернул письмо из корзины');
        }
        const validity = moved.uidValidity ?? (await imap.status(target, { uidValidity: true })).uidValidity;
        await this.emailRepository.update(email.id, {
          email_id: moved.uidMap?.get(+email.email_id) ?? null,
          from_mailbox: moved.destination ?? target,
          uidvalidity: validity ? String(validity) : null,
        });
      });
    }

    await this.emailRepository.restore(email.id);
    await this.emailRepository.update(email.id, { deleted_by: null, is_spam: false });
  }

  /** Flags the message \Junk and moves it to the spam mailbox. */
  async markAsSpam(id: number, user: User): Promise<void> {
    const email = await this.getAccessibleEmail(id, user);
    delete email.sent_by;

    if (!email.email_id) {
      await this.emailRepository.update(email.id, { is_spam: true });
      return;
    }

    const spam = this.connection.mailboxes.spam;

    try {
      await this.connection.withMailbox(email.from_mailbox, async (imap) => {
        const uid = `${email.email_id}`;
        await imap.messageFlagsAdd(uid, ['\\Junk'], { uid: true });

        const moved = await imap.messageMove(uid, spam, { uid: true });
        if (!moved) {
          throw new BadRequestException(
            'Error moving the email to spam folder!',
          );
        }

        // Without UIDPLUS the server does not tell the new uid: the row waits in
        // the spam mailbox without one, and the next sync of it finds it by Message-ID.
        const spamUidValidity =
          moved.uidValidity ??
          (await imap.status(spam, { uidValidity: true })).uidValidity;

        await this.emailRepository.update(email.id, {
          is_spam: true,
          email_id: moved.uidMap?.get(+email.email_id) ?? null,
          from_mailbox: moved.destination,
          uidvalidity: spamUidValidity ? String(spamUidValidity) : null,
        });
      });
    } catch (error) {
      this.loggerService.error(
        `Error moving the email ${id} to spam folder:`,
        error.stack,
      );

      throw error;
    }
  }

  /** «Не спам»: back to INBOX, without the \Junk flag. */
  async markAsNotSpam(id: number, user: User): Promise<void> {
    const email = await this.getAccessibleEmail(id, user);
    const inbox = this.connection.mailboxes.inbox;

    if (email.email_id && inbox && email.from_mailbox !== inbox) {
      await this.connection.withMailbox(email.from_mailbox, async (imap) => {
        const uid = `${email.email_id}`;
        await imap.messageFlagsRemove(uid, ['\\Junk'], { uid: true }).catch(() => undefined);
        const moved = await imap.messageMove(uid, inbox, { uid: true });
        if (!moved) {
          throw new BadRequestException('Почтовый сервер не переместил письмо во «Входящие»');
        }
        const validity = moved.uidValidity ?? (await imap.status(inbox, { uidValidity: true })).uidValidity;
        await this.emailRepository.update(email.id, {
          email_id: moved.uidMap?.get(+email.email_id) ?? null,
          from_mailbox: moved.destination ?? inbox,
          uidvalidity: validity ? String(validity) : null,
        });
      });
    }

    await this.emailRepository.update(email.id, { is_spam: false });
  }

  async getEmailFolders(): Promise<any> {
    return (await this.connection.client()).list();
  }

  /**
   * The recipients' addresses of all letters, for the admin's filter «Почты агентов». Others get an
   * empty list: an agent must not learn whom the company writes to.
   */
  async fetchEmailTo(
    query: FetchEmailToDto,
    user: User = null,
  ): Promise<PaginationResponseDto<EmailTo[]>> {
    const qb = this.emailToRepository.createQueryBuilder('t0');

    if (!user || !AuthGuard.MANAGER_LEVEL.includes(user.role)) {
      qb.where('FALSE');
    }

    if (query.search) {
      qb.andWhere('t0.value ILIKE :value', { value: `%${query.search}%` });
    }

    return this.helperService.withPagination(qb, query);
  }

  /** Letters the user may work with, with their addresses, files and people (403 for any other). */
  async accessibleLetters(ids: number[], user: User): Promise<Email[]> {
    const letters: Email[] = [];
    for (const id of [...new Set(ids.map(Number))]) {
      const email = await this.getAccessibleEmail(id, user, ['files', 'from_user', 'from_user.company']);
      letters.push(email);
    }
    return letters;
  }

  /** One letter the user may read, with its HTML part (the letter answered, the assistant's context). */
  async accessibleLetter(id: number, user: User): Promise<Email> {
    const email = await this.getAccessibleEmail(id, user, ['from_user']);
    email.html = await this.htmlOf(email.id);
    return email;
  }

  private async htmlOf(id: number): Promise<string | null> {
    const row = await this.emailRepository
      .createQueryBuilder('t0')
      .select('t0.id')
      .addSelect('t0.html')
      .withDeleted()
      .where('t0.id = :id', { id })
      .getOne();
    return row?.html ?? null;
  }

  /**
   * Adds to each letter its deals (the deals whose history it is in, those the user may see) and its
   * client (the contact / company of the sender, or of the recipients of a letter we sent).
   */
  private async describe(emails: Email[], authUser: AuthUser | null): Promise<void> {
    if (!emails.length) return;
    const access = authUser ? new Access(authUser) : null;

    const rows: any[] = await this.dataSource.query(
      `SELECT DISTINCT (e.after_state -> 'data') ->> 'id' AS email_id, d.id, d.label, d.display_id, d.agent_id,
              a.group_id, s.name AS stage, s.color AS stage_color, (d.closed_at IS NOT NULL) AS closed
         FROM event e
         JOIN deal d ON d.id = e.deal_id AND d.deleted_at IS NULL
         LEFT JOIN "user" a ON a.id = d.agent_id
         LEFT JOIN deal_stage s ON s.id = d.stage_id
        WHERE e.type = 9 AND (e.after_state -> 'data') ->> 'id' = ANY($1)`,
      [emails.map((e) => String(e.id))],
    );

    const counterparts = new Map<number, string[]>();
    for (const email of emails) {
      const addresses = email.outgoing
        ? addressesIn([...(email.to ?? []).map((r) => r.value), ...(email.cc ?? []).map((r) => r.value)])
        : addressesIn([email.from]);
      counterparts.set(email.id, addresses);
    }
    const all = [...new Set([...counterparts.values()].flat())];
    const contacts: any[] = all.length
      ? await this.dataSource.query(
          `SELECT u.id, u.username, lower(u.email) AS email, c.id AS company_id, c.name AS company_name
             FROM "user" u LEFT JOIN company c ON c.id = u.company_id AND c.deleted_at IS NULL
            WHERE u.role = $2 AND u.deleted_at IS NULL AND lower(u.email) = ANY($1)
            ORDER BY u.id`,
          [all, RoleEnum.CTR_AGENT],
        )
      : [];
    const companies: any[] = all.length
      ? await this.dataSource.query(
          `SELECT c.id, c.name, lower(c.email) AS email FROM company c WHERE c.deleted_at IS NULL AND lower(c.email) = ANY($1) ORDER BY c.id`,
          [all],
        )
      : [];

    for (const email of emails) {
      const deals: LetterDeal[] = rows
        .filter((row) => row.email_id === String(email.id))
        .filter((row) => !access || access.allowsDeal('view', row.agent_id ?? null, row.group_id ?? null))
        .filter((row, i, list) => list.findIndex((other) => other.id === row.id) === i)
        .map((row) => ({
          id: Number(row.id),
          label: row.label,
          display_id: Number(row.display_id),
          stage: row.stage ?? null,
          stage_color: row.stage_color ?? null,
          closed: !!row.closed,
        }));
      (email as any).deals = deals;

      const addresses = counterparts.get(email.id) ?? [];
      const contact = addresses.map((a) => contacts.find((c) => c.email === a)).find(Boolean);
      const company = contact?.company_id
        ? { id: Number(contact.company_id), name: contact.company_name }
        : addresses.map((a) => companies.find((c) => c.email === a)).find(Boolean);
      const client: LetterClient = {
        contact: contact ? { id: Number(contact.id), username: contact.username } : null,
        company: company ? { id: Number(company.id), name: company.name } : null,
      };
      (email as any).client = client;
    }
  }

  /**
   * Loads an email and checks that `user` may work with it: admin and manager
   * may with every email, an agent only with the emails of their own
   * mailboxes (their address or one of their checked sender accounts in From/To/Cc,
   * or sent by them from the CRM), the replies to their letters and the letters
   * of the deals they are responsible for.
   */
  private async getAccessibleEmail(
    id: number,
    user: User,
    relations: string[] = [],
    withDeleted = false,
  ): Promise<Email> {
    let qb = this.emailRepository.createQueryBuilder('t0');
    qb = this.helperService.withRelations(qb, ['to', 'cc', 'sent_by', ...relations]);
    if (withDeleted) qb = qb.withDeleted();
    const email = await qb.where('t0.id = :id', { id }).getOne();
    if (!email) {
      // getById's message, as before
      await this.helperService.getById(Email, id);
    }

    if (!(await this.canAccessEmail(email, user))) {
      throw new ForbiddenException('Это письмо принадлежит другому сотруднику');
    }

    return email;
  }

  private async canAccessEmail(email: Email, user: User): Promise<boolean> {
    if (!user) {
      return false;
    }

    if (AuthGuard.MANAGER_LEVEL.includes(user.role)) {
      return true;
    }

    if (email.sent_by?.id === user.id) {
      return true;
    }

    const own = await this.ownAddresses(user);
    if (email.from && own.includes(email.from.toLowerCase())) {
      return true;
    }

    const pattern = new RegExp(addressPattern(own), 'i');
    if (
      [...(email.to ?? []), ...(email.cc ?? [])].some((recipient) =>
        pattern.test(recipient.value ?? ''),
      )
    ) {
      return true;
    }

    // a reply to a letter they sent; a letter of a deal they are responsible for
    const rows = await this.dataSource.query(
      `SELECT
         EXISTS (SELECT 1 FROM email o WHERE $2::text IS NOT NULL AND o.message_id = $2 AND o.sent_by_id = $3) AS reply,
         EXISTS (SELECT 1 FROM event eh JOIN deal dh ON dh.id = eh.deal_id AND dh.deleted_at IS NULL
                  WHERE eh.type = 9 AND (eh.after_state -> 'data') ->> 'id' = $1 AND dh.agent_id = $3) AS deal`,
      [String(email.id), email.in_reply_to ?? null, user.id],
    );
    return !!(rows[0]?.reply || rows[0]?.deal);
  }

  /** Lower-cased addresses of the user: their own and their checked sender accounts. */
  private async ownAddresses(user: User): Promise<string[]> {
    const transporters = await this.emailTransporterRepository
      .createQueryBuilder('t0')
      .select('t0.email', 'email')
      .where('t0.user_id = :user_id', { user_id: user.id })
      // a mailbox saved before the password check gives no access to letters
      .andWhere('t0.verified_at IS NOT NULL')
      .getRawMany<{ email: string }>();

    const addresses = new Set<string>();
    [user.email, ...transporters.map((row) => row.email)]
      .filter((address) => !!address)
      .forEach((address) => addresses.add(address.toLowerCase()));

    return [...addresses];
  }
}

/** The access of a user loaded from the database (the request's token carries the same). */
export function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null;
  return {
    sub: user.id,
    username: user.username,
    role: user.role,
    permissions: user.permissions ?? null,
    group_id: (user as any).group?.id ?? (user as any).group_id ?? null,
  };
}

/**
 * Regex that finds one of the addresses inside a To/Cc header as stored
 * (`"Name" <a@b>, c@d`), without matching `xa@b` for `a@b`.
 */
function addressPattern(addresses: string[]): string {
  const escaped = addresses.map((address) =>
    address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );

  if (escaped.length === 0) {
    // Never matches, valid both in JS and in Postgres
    return '(?!x)x';
  }

  return `(^|[^A-Za-z0-9._%+-])(${escaped.join('|')})($|[^A-Za-z0-9._-])`;
}
