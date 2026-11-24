import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { FileLink } from './file-link';

/**
 * Every HTTP answer of the API: the names of uploaded files get their signed, expiring link (FileLink);
 * every request body: a signed name the client sends back is stored bare. Registered in main.ts.
 */
@Injectable()
export class FileLinkInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    if (request?.body && typeof request.body === 'object') FileLink.stripDeep(request.body);
    return next.handle().pipe(map((body) => FileLink.signDeep(body)));
  }
}
