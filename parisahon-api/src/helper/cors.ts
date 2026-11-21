/**
 * Which browser origins may call the API from another site (CORS). The CRM itself is served from the
 * same origin as /api/v1 and needs no CORS at all. Allowed: CRM_PUBLIC_URL, the comma-separated
 * CORS_ORIGINS, and in non-production setups the office network and localhost (dev web on :4150).
 * Requests without an Origin header (server to server, curl, the services) are not affected.
 */
const PRIVATE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|172\.0\.30\.\d+)(:\d+)?$/;

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(): string[] {
  const list = [originOf(process.env.CRM_PUBLIC_URL)];
  for (const item of (process.env.CORS_ORIGINS ?? '').split(',')) list.push(originOf(item.trim()));
  return list.filter((o): o is string => !!o);
}

export function corsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
  if (!origin) return callback(null, true);
  if (allowedOrigins().includes(origin)) return callback(null, true);
  if (!/^prod/i.test(process.env.APP_ENV ?? '') && PRIVATE.test(origin)) return callback(null, true);
  return callback(null, false);
}
