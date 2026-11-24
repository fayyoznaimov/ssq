import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SeedService } from './seed/seed.service';
import { FileService } from './file/file.service';
import { FileLink } from './file/file-link';
import { FileLinkInterceptor } from './file/file-link.interceptor';
import * as express from 'express';
import * as process from 'process';
import { corsOrigin } from './helper/cors';

async function bootstrap() {
  process.env.TZ = 'Asia/Karachi';
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('/api/v1');
  app.enableCors({ origin: corsOrigin, credentials: false });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // `whitelist: true` is deliberately NOT enabled yet. Checked against the
  // compiled DTOs with this very pipe: it would silently drop data that the
  // services rely on, because three DTOs do not declare what they receive:
  //  - company/dto/create.company.dto.ts: `users` is typed as the User entity
  //    (no validation decorators) -> every contact arrives as {}
  //  - company/dto/update.company.dto.ts: `users[].id` is not declared -> dropped
  //  - trigger/dto/assign.trigger.dto.ts: ChangeFieldContents.fields has no
  //    @Type(), DealFilter.value has no decorator -> dropped
  // Fix those three first, then turn it on.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    }),
  );

  /**
   * Seed necessary entities!
   * This could be done using migrations, but this way, application will check if necessary data exists
   * each time the application starts!
   */
  const seedService = app.get(SeedService);
  await seedService.seedGroups();
  await seedService.seedAdminUser();
  await seedService.seedDefaultCollection();
  await seedService.seedStages();
  await seedService.seedTaskTypes();
  await seedService.seedSettings();

  /**
   * Fix up deals without collections
   */
  await seedService.fixDealStages();

  /**
   * This ensures that only one collection is set as active
   */
  await seedService.fixCollectionStatuses();

  /**
   * Uploaded files. The client asks for <apiUrl>/uploads/<name>?e=…&s=…, i.e. /api/v1/uploads/...:
   * in production nginx serves that path itself (after GET /files/link-check), the dev and trial
   * copies have no nginx. <a href>, <img> and <audio> cannot send the token, so the API signs every
   * file name it returns (FileLinkInterceptor: valid 12 hours) and the link is checked here
   * (FileLink: FILE_LINK_ENFORCE=1 refuses an unsigned or expired one, otherwise it is logged).
   * A page-like file (.html, .svg) must not run scripts in the CRM origin: sandboxed.
   */
  app.useGlobalInterceptors(new FileLinkInterceptor());
  app.use(['/uploads', '/api/v1/uploads'], (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (FileLink.allows(req.originalUrl)) return next();
    res.status(403).type('text/plain').send('The link to the file is not valid or has expired');
  });
  app.use(
    ['/uploads', '/api/v1/uploads'],
    express.static(FileService.UPLOADS_DIR, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (FileService.isActiveContent(path)) {
          res.setHeader('Content-Security-Policy', 'sandbox');
        }
      },
    }),
  );

  // APP_LISTEN_PORT: the dev copy on the server runs next to the trial copy (see local/dev)
  await app.listen(Number(process.env.APP_LISTEN_PORT) || 3000);
}

bootstrap();
