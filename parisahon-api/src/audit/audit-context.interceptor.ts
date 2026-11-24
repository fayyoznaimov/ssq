import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { AuditContext } from './audit-context';
import { AuditService } from './audit.service';

/**
 * After the AuthGuard (interceptors run after the guards): the signed-in user becomes the author of
 * everything the request writes. POST /auth/login is followed here too — a successful login and a
 * failed one (with the e-mail, never the password) go to the journal without a line in the
 * authentication code.
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    const user = request?.user;
    if (user?.sub) AuditContext.setActor(Number(user.sub), user.username ?? null);

    const isLogin = context.getClass()?.name === 'AuthController' && context.getHandler()?.name === 'signIn';
    if (!isLogin) return next.handle();
    return next.handle().pipe(
      tap((body) => {
        void this.audit.loginSucceeded(request, body);
      }),
      catchError((error) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        void this.audit.loginFailed(request, status);
        return throwError(() => error);
      }),
    );
  }
}
