import { RecognitionModule } from '../recognition/recognition.module';
import { MailAssistService } from './mail-assist.service';
import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailController } from './email.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Email } from './email.entity';
import { HelperModule } from '../helper/helper.module';
import { EmailTransporter } from './email.transporter.entity';
import { User } from '../user/user.entity';
import { Event } from '../events/event.entity';
import { Deal } from '../deal/deal.entity';
import { EmailTemplate } from './email.template.entity';
import { EmailTo } from './email_to.entity';
import { MailConnectionService } from './mail-connection.service';
import { MailSyncService } from './mail-sync.service';
import { MailHistoryService } from './mail-history.service';
import { MailboxService } from './mailbox.service';
import { MailSendingService } from './mail-sending.service';
import { MailTransporterService } from './mail-transporter.service';
import { MailTemplateService } from './mail-template.service';
import { MailSignService } from './mail-sign.service';
import { MailDealsService } from './mail-deals.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Email,
      EmailTransporter,
      User,
      Event,
      Deal,
      EmailTemplate,
      EmailTo,
    ]),
    HelperModule,
    RecognitionModule,
  ],
  providers: [
    MailAssistService,
    EmailService,
    MailConnectionService,
    MailSyncService,
    MailHistoryService,
    MailDealsService,
    MailboxService,
    MailSendingService,
    MailTransporterService,
    MailTemplateService,
    MailSignService,
  ],
  controllers: [EmailController],
  exports: [EmailService],
})
export class EmailModule { }
