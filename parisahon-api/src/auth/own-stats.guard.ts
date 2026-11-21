import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from './auth.guard';

/**
 * For endpoints that return either the caller's own numbers (`?my_stats=true`)
 * or company-wide ones: the company-wide variant is for admin and manager only.
 * Runs after the global AuthGuard, which has already put the user on the request.
 */
@Injectable()
export class OwnStatsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const ownOnly = String(request.query?.my_stats ?? '').toLowerCase() === 'true';

    if (ownOnly || AuthGuard.MANAGER_LEVEL.includes(request.user?.role)) {
      return true;
    }

    throw new ForbiddenException(
      'Company-wide statistics are available to admin and manager only, use my_stats=true',
    );
  }
}
