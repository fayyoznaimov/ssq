import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth.guard';
import { RoleEnum } from '../user/user.entity';

/**
 * The "mail" switch in the staff card. The client only hides the menu entry;
 * this makes the server refuse too. Admin and manager always have mail.
 */
@Injectable()
export class MailAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user: AuthUser | undefined = context.switchToHttp().getRequest()
      ?.user;

    if (user?.role === RoleEnum.AGENT && user.permissions?.mail === false) {
      throw new ForbiddenException('Доступ к почте выключен для сотрудника');
    }

    return true;
  }
}
