import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CallsService } from './calls.service';
import { AuditJournal } from '../audit/audit-journal';

/** Processes the queue of received call recordings every CALLS_SCHEDULER_SEC seconds (default 30; 0 = off). */
@Injectable()
export class CallsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private calls: CallsService) {}

  static intervalMs(): number {
    const seconds = Number(process.env.CALLS_SCHEDULER_SEC || 30);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 30) * 1000;
  }

  onModuleInit(): void {
    if (process.env.CALLS_SCHEDULER_SEC === '0') return;
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), CallsScheduler.intervalMs());
  }

  async tick(): Promise<void> {
    try {
      // the journal (src/audit): what the queue of recordings writes is the receiver's (source «FTP»)
      const result = await AuditJournal.job('ftp', 'call-uploads', () => this.calls.processPending());
      if (result.done || result.failed) {
        this.logger.log(`call uploads: done ${result.done}, failed ${result.failed}`);
      }
    } catch (error) {
      this.logger.error(`tick failed: ${(error as Error).message}`);
    } finally {
      this.schedule();
    }
  }
}
