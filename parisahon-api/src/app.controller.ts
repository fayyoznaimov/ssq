import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppService } from './app.service';
import { Public } from './auth/decorator/public.decorator';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly dataSource: DataSource,
  ) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** For the server watchdog: is the API up and does it reach the database. Tells nothing else. */
  @Public()
  @Get('health')
  async health(): Promise<{ ok: boolean; db: boolean; uptime: number }> {
    let db = false;
    try {
      await this.dataSource.query('SELECT 1');
      db = true;
    } catch {
      db = false;
    }
    return { ok: db, db, uptime: Math.round(process.uptime()) };
  }
}
