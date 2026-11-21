import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthGuard } from '../auth/auth.guard';
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

/**
 * The stored emails as the staff work with them: list, open (marks read),
 * spam, delete. Admin and manager see every email, an agent only the emails
 * of their own mailboxes.
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
    private connection: MailConnectionService,
    private helperService: HelperService,
    private loggerService: LoggerService,
  ) {}

  async fetchLocalEmails(
    query: SearchEmailDto,
    user: User = null,
  ): Promise<PaginationResponseDto<Email[]>> {
    const qb = this.emailRepository.createQueryBuilder('t0');
    const relations = ['to', 'cc'];

    // An agent sees only the emails of their own mailboxes; admin and manager see all.
    if (user && user.role == RoleEnum.AGENT) {
      const own = await this.ownAddresses(user);
      qb.leftJoin('t0.to', 't4')
        .leftJoin('t0.cc', 't5')
        .andWhere(
          '(t0.sent_by_id = :user_id OR LOWER(t0.from) IN (:...own) OR t4.value ~* :own_re OR t5.value ~* :own_re)',
          {
            user_id: user.id,
            // IN () is a syntax error; the pattern never matches an empty list
            own: own.length ? own : [''],
            own_re: addressPattern(own),
          },
        );
    }

    if (user && user.role == RoleEnum.ADMIN && query.email_to) {
      qb.leftJoin('t0.to', 't4').andWhere('t4.value = :email_to', {
        email_to: query.email_to,
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

    if (query.is_spam) {
      qb.andWhere('t0.is_spam = :is_spam', { is_spam: query.is_spam });
    } else {
      qb.andWhere('t0.is_spam = false');
    }

    if (query.deal_label || query.with_deal || query.stages) {
      qb.leftJoinAndSelect('t0.from_user', 't1');
      qb.leftJoinAndSelect('t1.linked_deals', 't2');

      if (query.deal_label) {
        qb.andWhere('t2.label ILIKE :deal_label', {
          deal_label: `%${query.deal_label}%`,
        });
      }

      if (query.with_deal?.toLowerCase() === 'true') {
        qb.andWhere('t2.id IS NOT NULL');
      }

      if (query.with_deal?.toLowerCase() === 'false') {
        qb.andWhere('t2.id IS NULL');
      }

      if (query.stages) {
        qb.andWhere('t2.stage_id IN (:...stage_ids)', {
          stage_ids: query.stages,
        });
      }
    } else {
      relations.push('from_user', 'from_user.linked_deals');
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
      qb.andWhere('t0.read = :read', {
        read: query.read.toLowerCase() === 'true',
      });
    }

    if (query.outgoing) {
      qb.andWhere('t0.outgoing = :outgoing', {
        outgoing: query.outgoing.toLowerCase() === 'true',
      });
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, relations, 't0', 5),
      query,
    );
  }

  async fetchOneLocalEmail(id: number, user: User): Promise<Email> {
    let email = await this.getAccessibleEmail(id, user, ['files']);

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

      email.read = true;
      email = await this.emailRepository.save(email);
    }

    // The relation only served the access check
    delete email.sent_by;

    return email;
  }

  async deleteEmail(id: number, user: User): Promise<void> {
    const email = await this.getAccessibleEmail(id, user);

    // A copy that is no longer on the server (UIDVALIDITY changed) is only local
    if (!email.email_id) {
      await this.emailRepository.softDelete(email.id);
      return;
    }

    try {
      await this.connection.withMailbox(email.from_mailbox, async (imap) => {
        if (!(await imap.messageDelete([+email.email_id], { uid: true }))) {
          throw new BadRequestException('Could not delete email!');
        }

        await this.emailRepository.softDelete(email.id);
      });
    } catch (error) {
      this.loggerService.error(`Error deleting email ${id}`, error.stack);
      throw error;
    }
  }

  /** Flags the message \Junk and moves it to the spam mailbox. */
  async markAsSpam(id: number, user: User): Promise<void> {
    const email = await this.getAccessibleEmail(id, user);
    delete email.sent_by;

    if (!email.email_id) {
      email.is_spam = true;
      await this.emailRepository.save(email);
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

        // Without UIDPLUS the server does not tell the new uid: the copy is
        // then found again by Message-ID on the next sync of the spam folder.
        const spamUidValidity =
          moved.uidValidity ??
          (await imap.status(spam, { uidValidity: true })).uidValidity;

        email.is_spam = true;
        email.email_id = moved.uidMap?.get(+email.email_id) ?? null;
        email.from_mailbox = moved.destination;
        email.uidvalidity = spamUidValidity ? String(spamUidValidity) : null;
        await this.emailRepository.save(email);
      });
    } catch (error) {
      this.loggerService.error(
        `Error moving the email ${id} to spam folder:`,
        error.stack,
      );

      throw error;
    }
  }

  async getEmailFolders(): Promise<any> {
    return (await this.connection.client()).list();
  }

  async fetchEmailTo(
    query: FetchEmailToDto,
  ): Promise<PaginationResponseDto<EmailTo[]>> {
    const qb = this.emailToRepository.createQueryBuilder('t0');

    if (query.search) {
      qb.where('t0.value ILIKE :value', { value: `%${query.search}%` });
    }

    return this.helperService.withPagination(qb, query);
  }

  /**
   * Loads an email and checks that `user` may work with it: admin and manager
   * may with every email, an agent only with the emails of their own
   * mailboxes (their address or one of their sender accounts in From/To/Cc,
   * or sent by them from the CRM).
   */
  private async getAccessibleEmail(
    id: number,
    user: User,
    relations: string[] = [],
  ): Promise<Email> {
    const email = await this.helperService.getById(Email, id, [
      'to',
      'cc',
      'sent_by',
      ...relations,
    ]);

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
    return [...(email.to ?? []), ...(email.cc ?? [])].some((recipient) =>
      pattern.test(recipient.value ?? ''),
    );
  }

  /** Lower-cased addresses of the user: their own and their sender accounts. */
  private async ownAddresses(user: User): Promise<string[]> {
    const transporters = await this.emailTransporterRepository
      .createQueryBuilder('t0')
      .select('t0.email', 'email')
      .where('t0.user_id = :user_id', { user_id: user.id })
      .getRawMany<{ email: string }>();

    const addresses = new Set<string>();
    [user.email, ...transporters.map((row) => row.email)]
      .filter((address) => !!address)
      .forEach((address) => addresses.add(address.toLowerCase()));

    return [...addresses];
  }
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
