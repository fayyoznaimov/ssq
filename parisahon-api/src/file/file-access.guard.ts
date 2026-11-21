import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth.guard';
import { RoleEnum } from '../user/user.entity';

/**
 * The "files" switch in the staff card for GET /files (the list of all files).
 * The client only hid the menu entry; admin and manager always pass. The files
 * tab of a deal is not affected.
 */
@Injectable()
export class FileAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user: AuthUser | undefined = context
      .switchToHttp()
      .getRequest()?.user;

    if (user?.role === RoleEnum.AGENT && user.permissions?.file === false) {
      throw new ForbiddenException('Список файлов выключен для сотрудника');
    }

    return true;
  }
}
