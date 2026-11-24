import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../events/event.entity';
import { AuditContextInterceptor } from './audit-context.interceptor';
import { AuditContextMiddleware } from './audit-context.middleware';
import { AuditLog } from './audit-log.entity';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditSubscriber } from './audit.subscriber';

/**
 * The journal «кто что изменил» and the common «История событий» (AUDIT-1…4, 11, 13, 14, 16, ACL-10,
 * TASK-5, TRG-5, CALL-12, DEAL-4, WA-16):
 *  - audit-context: who acts and from where (AsyncLocalStorage), opened for every HTTP request
 *    (middleware: request id, address, source by route; interceptor: the user after the AuthGuard)
 *    and by the bot, the triggers and the jobs for their own work;
 *  - audit.subscriber + audit-hooks + AuditJournal.around: the rows of audit_log, in the transaction
 *    of the change, never breaking it;
 *  - audit.service / audit-render / audit.controller: the history in human language, the logins,
 *    the nightly cleanup.
 * Env: AUDIT_LOG=0 switches the recording off, AUDIT_RETENTION_DAYS (1095) how long rows are kept.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, Event])],
  controllers: [AuditController],
  providers: [AuditService, AuditSubscriber, { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor }],
  exports: [AuditService],
})
export class AuditModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuditContextMiddleware).forRoutes('*');
  }
}
