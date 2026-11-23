import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';

/**
 * The "files" switch in the staff card for GET /files (the list of files).
 * The client only hid the menu entry; admin and manager always pass, an agent
 * unless the switch is off — the one rule of Access.canUseFiles, which GET
 * /auth/access gives the client for its menu. What the list holds for an agent
 * is limited by their deal rights and the mail switch (FileService.fetchFiles),
 * so an agent without stored permissions no longer sees every file either.
 * The files tab of a deal is not affected.
 */
@Injectable()
export class FileAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user: AuthUser | undefined = context
      .switchToHttp()
      .getRequest()?.user;

    if (user && !new Access(user).canUseFiles) {
      throw new ForbiddenException('Список файлов выключен для сотрудника');
    }

    return true;
  }
}
