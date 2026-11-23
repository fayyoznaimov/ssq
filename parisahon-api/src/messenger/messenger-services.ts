/**
 * Where the two messenger services are and how the API proves itself to them (one place for
 * TelegramService, the remote-file download, the lookups and the health job).
 *
 *  - parisahon-telegram-service: TELEGRAM_SERVICE_HOST (+ TELEGRAM_SERVICE_PORT). Every request carries
 *    X-Telegram-Service-Token = TELEGRAM_SERVICE_HTTP_TOKEN, or TELEGRAM_SERVICE_TOKEN when that is not
 *    set (the same shared secret the service already sends to POST /telegram/incoming, so the
 *    production env needs no change). The service answers 401 to anything else (except /health).
 *  - parisahon-whatsapp-service: WHATSAPP_SERVICE_URL + WHATSAPP_SERVICE_TOKEN (X-WhatsApp-Service-Token).
 */

export function telegramServiceUrl(): string {
  const host = (process.env.TELEGRAM_SERVICE_HOST || '').replace(/\/+$/, '');
  const port = process.env.TELEGRAM_SERVICE_PORT;
  return port && port !== '80' && !/:\d+$/.test(host) ? `${host}:${port}` : host;
}

/** false on a copy without the service (no host, or a *.invalid placeholder). */
export function telegramServiceConfigured(): boolean {
  const url = telegramServiceUrl();
  return Boolean(url) && !/\.invalid(:|$)/.test(url);
}

export function telegramServiceHeaders(): Record<string, string> {
  const token = (process.env.TELEGRAM_SERVICE_HTTP_TOKEN || process.env.TELEGRAM_SERVICE_TOKEN || '').trim();
  return token ? { 'X-Telegram-Service-Token': token } : {};
}

export function whatsappServiceUrl(): string {
  return (process.env.WHATSAPP_SERVICE_URL ?? '').replace(/\/+$/, '');
}

export function whatsappServiceConfigured(): boolean {
  return Boolean(whatsappServiceUrl() && (process.env.WHATSAPP_SERVICE_TOKEN ?? ''));
}

export function whatsappServiceHeaders(): Record<string, string> {
  const token = process.env.WHATSAPP_SERVICE_TOKEN ?? '';
  return token ? { 'X-WhatsApp-Service-Token': token } : {};
}

/** The service did not answer at all (network, timeout). */
export class ServiceUnreachable extends Error {}

/** One HTTP call to a service: the status and the parsed JSON answer (null when it is not JSON). */
export async function callService(
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<{ status: number; payload: any }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ServiceUnreachable((error as Error)?.name === 'TimeoutError' ? 'timeout' : (error as Error)?.message || 'network error');
  }
  const payload: any = await response.json().catch(() => null);
  return { status: response.status, payload };
}
