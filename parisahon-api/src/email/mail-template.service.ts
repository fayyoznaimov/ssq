import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import { CreateTemplateDto } from './dto/create.template.dto';
import { EmailTemplate } from './email.template.entity';

/** Email templates: personal, each user sees and changes only their own. */
@Injectable()
export class MailTemplateService {
  constructor(
    @InjectRepository(EmailTemplate)
    private emailTemplateRepository: Repository<EmailTemplate>,
    private helperService: HelperService,
  ) {}

  async fetchEmailTemplates(request: Request): Promise<EmailTemplate[]> {
    return this.emailTemplateRepository
      .createQueryBuilder('t0')
      .where('t0.created_by = :created_by', {
        created_by: this.helperService.extractUserIdFromRequest(request),
      })
      .getMany();
  }

  async fetchEmailTemplateById(
    id: number,
    request: Request,
  ): Promise<EmailTemplate> {
    const template = await this.emailTemplateRepository
      .createQueryBuilder('t0')
      .where('t0.id = :id', { id: id })
      .andWhere('t0.created_by = :created_by', {
        created_by: this.helperService.extractUserIdFromRequest(request),
      })
      .getOne();

    if (!template) {
      throw new NotFoundException(
        `EmailTemplate with id ${id} does not exist!`,
      );
    }

    return template;
  }

  async createEmailTemplate(
    data: CreateTemplateDto,
    request: Request,
  ): Promise<EmailTemplate> {
    const newTemplate = new EmailTemplate();
    newTemplate.template_body = data.template_body;
    newTemplate.name = data.name;
    newTemplate.subject = data.subject;
    newTemplate.created_by =
      await this.helperService.extractUserFromRequest(request);

    return this.emailTemplateRepository.save(newTemplate);
  }

  async updateEmailTemplate(
    id: number,
    data: CreateTemplateDto,
    request: Request,
  ): Promise<void> {
    const template = await this.fetchOwn(
      id,
      request,
      'Can only modify templates that belong to you!',
    );

    template.template_body = data.template_body;
    template.subject = data.subject;
    template.name = data.name;

    await this.emailTemplateRepository.save(template);
  }

  async deleteTemplate(id: number, request: Request): Promise<void> {
    const template = await this.fetchOwn(
      id,
      request,
      'Can only delete templates that belong to you!',
    );

    await this.emailTemplateRepository.delete(template);
  }

  /** 404 for an unknown template, 403 (`refusal`) for someone else's. */
  private async fetchOwn(
    id: number,
    request: Request,
    refusal: string,
  ): Promise<EmailTemplate> {
    const template = await this.helperService.getById(EmailTemplate, id, [
      'created_by',
    ]);

    if (
      template.created_by.id !==
      this.helperService.extractUserIdFromRequest(request)
    ) {
      throw new ForbiddenException(refusal);
    }

    return template;
  }
}
