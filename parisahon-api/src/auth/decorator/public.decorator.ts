import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt-out of the global AuthGuard. Every route requires a valid JWT unless
 * it (or its controller) is explicitly marked with @Public().
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
