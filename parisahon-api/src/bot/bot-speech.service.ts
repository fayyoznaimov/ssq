import { Injectable, Logger } from '@nestjs/common';

/**
 * Speech-to-text of the bot's voice messages through the local service parisahon-stt
 * (faster-whisper on the CPU, no paid API). The service may be down: every failure
 * becomes a SpeechError with a kind the bot turns into a clear answer.
 *
 * Settings (env):
 *   CRM_BOT_STT_URL          address of parisahon-stt (dev: http://127.0.0.1:8097); empty = voice messages off
 *   CRM_BOT_STT_TOKEN        Bearer token if the service has STT_TOKEN (needed when it is not on 127.0.0.1)
 *   CRM_BOT_STT_TIMEOUT_SEC  how long to wait for a transcription (default 150)
 *   CRM_BOT_VOICE_MAX_SEC    longest voice message the bot accepts (default 180 = 3 minutes)
 */

export type SpeechErrorKind = 'off' | 'unavailable' | 'too_long' | 'bad_audio';

export class SpeechError extends Error {
  constructor(
    readonly kind: SpeechErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface Transcript {
  text: string;
  language: string | null;
  duration: number;
  seconds: number;
}

@Injectable()
export class BotSpeechService {
  private readonly logger = new Logger(BotSpeechService.name);

  private get url() {
    return (process.env.CRM_BOT_STT_URL || '').trim().replace(/\/+$/, '');
  }

  get enabled() {
    return !!this.url;
  }

  get maxSeconds() {
    return Math.max(5, Number(process.env.CRM_BOT_VOICE_MAX_SEC || 180));
  }

  private get timeoutMs() {
    return Math.max(10, Number(process.env.CRM_BOT_STT_TIMEOUT_SEC || 150)) * 1000;
  }

  async transcribe(audio: Buffer): Promise<Transcript> {
    if (!this.enabled) throw new SpeechError('off', 'CRM_BOT_STT_URL is not set');
    const token = (process.env.CRM_BOT_STT_TOKEN || '').trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    let response: Response;
    let body: any;
    try {
      response = await fetch(`${this.url}/transcribe?max_sec=${this.maxSeconds}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: audio,
        signal: controller.signal,
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      const reason = (error as Error)?.name === 'AbortError' ? 'timeout' : (error as any)?.cause?.code ?? (error as Error)?.message;
      this.logger.warn(`speech-to-text is unavailable: ${reason}`);
      throw new SpeechError('unavailable', String(reason));
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 413) throw new SpeechError('too_long', body?.error ?? 'too long');
    if (response.status === 400) throw new SpeechError('bad_audio', body?.error ?? 'bad audio');
    if (!response.ok || typeof body?.text !== 'string') {
      this.logger.warn(`speech-to-text answered HTTP ${response.status} ${body?.error ?? ''}`);
      throw new SpeechError('unavailable', `HTTP ${response.status}`);
    }
    // the words themselves are the manager's message: not logged
    this.logger.log(`voice ${body.duration} s (${body.language}) transcribed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return { text: body.text.trim(), language: body.language ?? null, duration: Number(body.duration) || 0, seconds: Number(body.seconds) || 0 };
  }
}
