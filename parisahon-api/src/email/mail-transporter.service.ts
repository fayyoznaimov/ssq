import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as CryptoJS from 'crypto-js';
import { Request } from 'express';
import * as process from 'process';
import { Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import { CreateTransporterDto } from './dto/create.transporter.dto';
import { EmailTransporter } from './email.transporter.entity';

/**
 * Sender accounts ("transporters"): mailboxes of the company mail server a
 * user sends from instead of the shared one. Each user sees only their own.
 */
@Injectable()
export class MailTransporterService {
  constructor(
    @InjectRepository(EmailTransporter)
    private emailTransporterRepository: Repository<EmailTransporter>,
    private helperService: HelperService,
  ) {}

  async fetchTransporters(request: Request): Promise<EmailTransporter[]> {
    return this.emailTransporterRepository
      .createQueryBuilder('t0')
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
    const newTransporter = new EmailTransporter();

    newTransporter.email = data.email;
    newTransporter.password = encryptPassword(data.password);
    newTransporter.created_by =
      await this.helperService.extractUserFromRequest(request);

    return await this.emailTransporterRepository.save(newTransporter);
  }

  async updateTransporter(
    id: number,
    data: CreateTransporterDto,
    request: Request,
  ): Promise<void> {
    const transporter = await this.fetchTransporterById(id, request);

    transporter.email = data.email;
    if (data.password) {
      transporter.password = encryptPassword(data.password);
    }

    await this.emailTransporterRepository.save(transporter);
  }

  async deleteTransporter(id: number, request: Request): Promise<void> {
    const transporter = await this.fetchTransporterById(id, request);

    await this.emailTransporterRepository.delete(transporter.id);
  }

  /** A sender account of the user `userId`; anyone else's is 403. */
  async fetchOwn(id: number, userId: number): Promise<EmailTransporter> {
    const transporter = await this.helperService.getById(EmailTransporter, id, [
      'created_by',
    ]);

    if (transporter.created_by.id !== userId) {
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

/**
 * Reversible (AES with HASH_SECRET), not a hash: SMTP needs the password in
 * plain text.
 */
function encryptPassword(password: string): string {
  return CryptoJS.AES.encrypt(password, process.env.HASH_SECRET).toString();
}
