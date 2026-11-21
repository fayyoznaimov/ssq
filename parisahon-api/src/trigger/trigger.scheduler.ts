import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { LoggerService } from '../helper/logger.service';

/**
 * Executes the schedule in `trigger_run` (see TriggerService): every
 * TRIGGER_SCHEDULER_SEC seconds (default 30) the due runs are executed and the
 * next runs of recurring triggers are planned. Nothing is kept in memory, so a
 * restart only delays a run until the next tick; a failing trigger is a
 * `failed` row. Never runs twice at once (`running`), and every tick is caught.
 */
@Injectable()
export class TriggerScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private triggerService: TriggerService,
    private loggerService: LoggerService,
  ) {}

  static intervalMs(): number {
    const seconds = Number(process.env.TRIGGER_SCHEDULER_SEC || 30);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 30) * 1000;
  }

  onModuleInit(): void {
    if (process.env.TRIGGER_SCHEDULER_SEC === '0') {
      this.logger.log('trigger scheduler is off (TRIGGER_SCHEDULER_SEC=0)');
      return;
    }
    this.schedule(TriggerScheduler.intervalMs());
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.triggerService.runDue();
      if (result.planned || result.executed || result.failed || result.skipped) {
        this.loggerService.log(
          `trigger scheduler: planned ${result.planned}, executed ${result.executed}, failed ${result.failed}, skipped ${result.skipped}`,
        );
      }
    } catch (error) {
      this.loggerService.error('trigger scheduler tick failed', (error as Error).stack);
      this.logger.error(`tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
      this.schedule(TriggerScheduler.intervalMs());
    }
  }
}
