import { Controller, Get, Post } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

/** The schedule by hand (admin only) and what the trigger form offers (every employee may read a trigger). */
@Controller('triggers')
export class TriggerRunController {
  constructor(private readonly triggerService: TriggerService) {}

  /** One tick of the trigger scheduler now; `busy` when another tick is running. */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post('run-due')
  async runDue(): Promise<{ planned: number; executed: number; failed: number; skipped: number; busy?: boolean }> {
    return this.triggerService.runDue();
  }

  /**
   * The e-mail templates a trigger may send: every user's (GET /emails/templates gives only one's own,
   * so the admin could not pick a template of the manager who wrote it). Names and subjects only; an
   * agent reads them too (the form of a trigger shows its template, read-only).
   */
  @Get('email-templates')
  async emailTemplates(): Promise<{ id: number; name: string; subject: string; owner: string | null }[]> {
    return this.triggerService.emailTemplates();
  }

  /** The stages of every pipeline, for «Создать сделку» and «Перевести в этап» (a copy may go to production). */
  @Get('stages')
  async stages(): Promise<{ id: number; name: string; collection_id: number | null; collection: string | null; is_active: boolean }[]> {
    return this.triggerService.allStages();
  }

  /** Broken triggers of every stage (they name a dismissed employee, a deleted template ...). */
  @Roles(AuthGuard.MANAGER_LEVEL)
  @Get('broken')
  async broken(): Promise<{ id: number; stage_id: number; stage: string; action: string; problems: string[] }[]> {
    return this.triggerService.brokenTriggers();
  }
}
