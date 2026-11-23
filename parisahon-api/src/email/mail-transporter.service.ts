import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as CryptoJS from 'crypto-js';
import { Request } from 'express';
import * as nodemailer from 'nodemailer';
import * as process from 'process';
import { Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import { RoleEnum } from '../user/user.entity';
import { CreateTransporterDto } from './dto/create.transporter.dto';
import { EmailTransporter } from './email.transporter.entity';

/**
 * Sender accounts ("transporters"): mailboxes of the company mail server a
 * user sends from instead of the shared one. Each user sees only their own; the admin sees all
 * (GET /emails/transporters?all=true) and may delete any.
 *
 * A mailbox is saved only for the user's own address (the admin: any address) and only when the
 * mail server accepts the address and password: a mailbox also shows its letters to its owner, so
 * an agent could otherwise read a colleague's mail by adding their address with any password.
 */
@Injectable()
export class MailTransporterService {
  constructor(
    @InjectRepository(EmailTransporter)
    private emailTransporterRepository: Repository<EmailTransporter>,
    private helperService: HelperService,
  ) {}

  async fetchTransporters(request: Request, all = false): Promise<EmailTransporter[]> {
    const qb = this.emailTransporterRepository.createQueryBuilder('t0');
    if (all && request['user']?.role === RoleEnum.ADMIN) {
      // the admin's overview: whose mailbox it is
      return qb
        .leftJoin('t0.created_by', 'owner')
        .addSelect(['owner.id', 'owner.username', 'owner.email'])
        .orderBy('t0.id', 'ASC')
        .getMany();
    }
    return qb
      .where('t0.created_by = :user_id', {
        user_id: this.helperService.extractUserIdFromRequest(request),
      })
      .getMany();
  }

  async fetchTransporterById(
    id: number,
    request: Request,
  ): Promise<EmailTransporter> {
    return this.fetchOwn(
      id,
      this.helperService.extractUserIdFromRequest(request),
    );
  }

  async createTransporter(
    data: CreateTransporterDto,
    request: Request,
  ): Promise<EmailTransporter> {
    const owner = await this.helperService.extractUserFromRequest(request);
    const email = data.email.trim();
    assertMayUse(email, owner.email, owner.role);
    await verifyMailbox(email, data.password);

    const newTransporter = new EmailTransporter();

    newTransporter.email = email;
    newTransporter.password = encryptPassword(data.password);
    newTransporter.created_by = owner;
    newTransporter.verified_at = new Date();

    const saved = await this.emailTransporterRepository.save(newTransporter);
    delete saved.created_by;
    return saved;
  }

  async updateTransporter(
    id: number,
    data: CreateTransporterDto,
    request: Request,
  ): Promise<void> {
    const transporter = await this.fetchTransporterById(id, request);
    const owner = await this.helperService.extractUserFromRequest(request);
    const email = data.email.trim();
    assertMayUse(email, owner.email, owner.role);

    const password = data.password || this.decryptPassword(transporter.password);
    if (email.toLowerCase() !== transporter.email.toLowerCase() || data.password || !transporter.verified_at) {
      await verifyMailbox(email, password);
      transporter.verified_at = new Date();
    }

    transporter.email = email;
    if (data.password) {
      transporter.password = encryptPassword(data.password);
    }

    await this.emailTransporterRepository.save(transporter);
  }

  async deleteTransporter(id: number, request: Request): Promise<void> {
    const transporter =
      request['user']?.role === RoleEnum.ADMIN
        ? await this.helperService.getById(EmailTransporter, id)
        : await this.fetchTransporterById(id, request);

    await this.emailTransporterRepository.delete(transporter.id);
  }

  /** A sender account of the user `userId`; anyone else's is 403. */
  async fetchOwn(id: number, userId: number): Promise<EmailTransporter> {
    const transporter = await this.helperService.getById(EmailTransporter, id, [
      'created_by',
    ]);

    if (transporter.created_by?.id !== userId) {
      throw new ForbiddenException();
    }

    return transporter;
  }

  decryptPassword(encryptedPassword: string): string {
    const bytes = CryptoJS.AES.decrypt(
      encryptedPassword,
      process.env.HASH_SECRET,
    );
    return bytes.toString(CryptoJS.enc.Utf8);
  }
}

/** Only the user's own address; the admin may connect any mailbox. */
function assertMayUse(email: string, ownEmail: string | null, role: RoleEnum): void {
  if (role === RoleEnum.ADMIN) return;
  if (!ownEmail || email.toLowerCase() !== ownEmail.trim().toLowerCase()) {
    throw new ForbiddenException(
      `Подключить можно только свой почтовый ящик (${ownEmail || 'адрес вашей учётной записи'}). Чужой ящик подключает администратор.`,
    );
  }
}

/**
 * Logs in to the SMTP of the company mail server (EMAIL_HOST, EMAIL_SMTP_PORT) with the address and
 * password; the mailbox is saved only when the server accepts them.
 */
async function verifyMailbox(email: string, password: string): Promise<void> {
  const transport = nodemailer.createTransport({
    auth: { user: email, pass: password },
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT) || 465,
    secure: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.verify();
  } catch (error: any) {
    const code = String(error?.code ?? '');
    const status = Number(error?.responseCode) || 0;
    if (code === 'EAUTH' || [530, 534, 535].includes(status)) {
      throw new BadRequestException('Почтовый сервер не принял адрес или пароль ящика: ящик не сохранён. Проверьте пароль.');
    }
    throw new BadRequestException(
      `Не удалось проверить ящик на почтовом сервере (${error?.message ?? code ?? 'нет ответа'}): ящик не сохранён, попробуйте позже.`,
    );
  } finally {
    transport.close();
  }
}

/**
 * Reversible (AES with HASH_SECRET), not a hash: SMTP needs the password in
 * plain text.
 */
function encryptPassword(password: string): string {
  return CryptoJS.AES.encrypt(password, process.env.HASH_SECRET).toString();
}
