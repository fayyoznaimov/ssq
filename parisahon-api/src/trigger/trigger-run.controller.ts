import { Controller, Post } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

/** The schedule by hand: one tick of the trigger scheduler now (admin only). */
@Controller('triggers')
export class TriggerRunController {
  constructor(private readonly triggerService: TriggerService) {}

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post('run-due')
  async runDue(): Promise<{ planned: number; executed: number; failed: number; skipped: number }> {
    return this.triggerService.runDue();
  }
}
