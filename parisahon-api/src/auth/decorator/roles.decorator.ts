import { Reflector } from '@nestjs/core';

/**
 * Restricts a handler or a whole controller to the given roles:
 *   @Roles(AuthGuard.ADMIN_LEVEL)
 *
 * The metadata is stored under the decorator itself (Reflector.createDecorator),
 * so it must be read with `reflector.getAllAndOverride(Roles, [handler, class])`
 * and not with the string key 'roles'. A handler-level @Roles overrides the
 * class-level one.
 */
export const Roles = Reflector.createDecorator<string[]>();
