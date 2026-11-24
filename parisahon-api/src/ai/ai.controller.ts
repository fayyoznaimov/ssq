import { Controller, Get } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { AI } from './ai.config';
import { AiQueueService } from './ai-queue.service';

/** The state of the AI for admins and managers: switches, today's budget, the pause, the queue, the CLI. */
@Controller('ai')
@Roles(AuthGuard.MANAGER_LEVEL)
export class AiController {
  constructor(private queue: AiQueueService) {}

  @Get('status')
  async status() {
    if (!AI.enabled) return { features: AI.features() };
    return this.queue.status();
  }
}
