import { getCircuitBreaker } from '../../../infrastructure/circuit-breaker.js';
import type { MessengerErrorType, MessengerSendResult } from './messenger.types.js';

function classify(status: number, code: number, transient: boolean): { type: MessengerErrorType; retryable: boolean } {
  if (status === 429 || [4, 17, 32, 613].includes(code)) return { type: 'RATE_LIMIT', retryable: true };
  if ([190, 102, 200, 10].includes(code) || status === 401 || status === 403) return { type: 'AUTH_ERROR', retryable: false };
  if (status >= 500 || transient) return { type: 'PROVIDER_ERROR', retryable: true };
  return { type: 'VALIDATION_ERROR', retryable: false };
}

export class MetaGraphClient {
  private readonly breaker = getCircuitBreaker('facebook');
  constructor(private readonly version: string, private readonly timeoutMs: number, private readonly fetchImpl: typeof fetch = fetch) {}

  async request(pageId: string, token: string, path: string, init: RequestInit = {}): Promise<MessengerSendResult> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.breaker.execute(() => this.fetchImpl(`https://graph.facebook.com/${this.version}/${encodeURIComponent(pageId)}${path}`, {
        ...init, signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      }));
    } catch (error) {
      clearTimeout(timeout);
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return { success: false, errorCode: timedOut ? 'META_TIMEOUT' : 'META_NETWORK_ERROR', errorMessage: timedOut ? 'Messenger request timed out' : 'Messenger network request failed', errorType: 'NETWORK_ERROR', retryable: true, uncertain: true };
    }
    clearTimeout(timeout);
    let body: Record<string, unknown> = {};
    try { const parsed = await response.json(); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; }
    catch { return { success: false, errorCode: 'META_MALFORMED_RESPONSE', errorMessage: 'Meta returned malformed JSON', errorType: 'PROVIDER_ERROR', retryable: response.status >= 500, uncertain: response.status >= 500 }; }
    if (!response.ok) {
      const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error as Record<string, unknown> : {};
      const code = Number(error.code ?? 0); const result = classify(response.status, code, error.is_transient === true);
      const retryAfter = Number(response.headers.get('retry-after'));
      return { success: false, errorCode: code ? String(code) : `HTTP_${response.status}`, errorMessage: typeof error.message === 'string' ? error.message.slice(0, 500) : 'Meta API rejected the request', errorType: result.type, retryable: result.retryable, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : undefined, rawResponse: body };
    }
    const externalMessageId = typeof body.message_id === 'string' ? body.message_id : undefined;
    return { success: true, externalMessageId, rawResponse: body, retryable: false };
  }
}
