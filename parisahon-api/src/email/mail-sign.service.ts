import { escapeHtml } from '../helper/safe-html';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import { RoleEnum, User } from '../user/user.entity';
import { CreateSignDto, UserWithSign } from './dto/create.sign.dto';

/** Email signatures of the staff (User.sign); contacts have none. */
@Injectable()
export class MailSignService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private helperService: HelperService,
  ) {}

  async fetchUsersWithSigns(): Promise<UserWithSign[]> {
    return this.signs().getRawMany<UserWithSign>();
  }

  async fetchSignByUserId(user_id: number): Promise<UserWithSign> {
    const userWithSign = await this.signs()
      .andWhere('t0.id = :user_id', { user_id: user_id })
      .getRawOne<UserWithSign>();

    if (!userWithSign) {
      // no signature of their own: the company template with the manager's name, phone and e-mail
      const company = await this.companySignature(user_id);
      if (company) return company;
      throw new NotFoundException(
        `User ${user_id} does not have a sign set up!`,
      );
    }

    return userWithSign;
  }

  async upsertUserSign(
    data: CreateSignDto,
    request: Request,
  ): Promise<UserWithSign> {
    this.assertCanEditSign(data.user_id, request);
    const user = await this.helperService.getById(User, data.user_id);

    if (user.role === RoleEnum.CTR_AGENT) {
      throw new BadRequestException('Cannot set up a sign for ctr_agent');
    }

    user.sign = data.sign;

    const savedUser = await this.userRepository.save(user);

    return {
      user_id: user.id,
      username: savedUser.username,
      sign: data.sign,
    };
  }

  async deleteUserSign(user_id: number, request: Request): Promise<void> {
    this.assertCanEditSign(user_id, request);
    const user = await this.helperService.getById(User, user_id);

    user.sign = null;
    await this.userRepository.save(user);
  }

  /** Staff (not contacts) that have a signature, as UserWithSign rows. */
  private signs() {
    return this.userRepository
      .createQueryBuilder('t0')
      .select('t0.id', 'user_id')
      .addSelect('t0.username', 'username')
      .addSelect('t0.sign', 'sign')
      .where('t0.sign IS NOT NULL')
      .andWhere('t0.role != :ctr_agent', { ctr_agent: RoleEnum.CTR_AGENT });
  }

  /**
   * A signature is personal: only its owner changes it, and the admin any.
   */
  private assertCanEditSign(user_id: number, request: Request): void {
    const requester = request['user'];

    if (
      this.helperService.extractUserIdFromRequest(request) !== user_id &&
      requester?.role !== RoleEnum.ADMIN
    ) {
      throw new ForbiddenException('Можно менять только свою подпись');
    }
  }

  /** The company signature (setting.mail_signature) filled in for a staff user, or null. */
  private async companySignature(user_id: number): Promise<UserWithSign | null> {
    const rows = await this.userRepository.manager.query(
      `SELECT u.id, u.username, u.phone, u.email, u.role,
              (SELECT s.mail_signature FROM setting s ORDER BY s.id DESC LIMIT 1) AS template
         FROM "user" u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [user_id],
    );
    const row = rows[0];
    if (!row || row.role === RoleEnum.CTR_AGENT || !row.template) return null;
    const sign = String(row.template)
      .replace(/\{\{\s*name\s*\}\}/g, escapeHtml(row.username ?? ''))
      .replace(/\{\{\s*phone\s*\}\}/g, escapeHtml(row.phone ?? ''))
      .replace(/\{\{\s*email\s*\}\}/g, escapeHtml(row.email ?? ''));
    return { user_id: row.id, username: row.username, sign } as UserWithSign;
  }
}
