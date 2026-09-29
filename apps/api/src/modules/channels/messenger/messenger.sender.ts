import type { MessengerConfig } from './messenger.config.js';
import type { MessengerSendResult } from './messenger.types.js';

function safeError(body: Record<string, unknown>) {
  const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : {};
  return {
    code: typeof error.code === 'number' || typeof error.code === 'string' ? String(error.code) : 'META_API_ERROR',
    message: typeof error.message === 'string' ? error.message.slice(0, 500) : 'Meta Messenger API rejected the message',
    transient: error.is_transient === true || [4, 17, 32, 613].includes(Number(error.code)),
  };
}

export class MessengerSender {
  constructor(private readonly config: MessengerConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async sendText(recipientId: string, text: string): Promise<MessengerSendResult> {
    if (!this.config.pageId || !this.config.pageAccessToken) {
      return { success: false, errorCode: 'MESSENGER_NOT_CONFIGURED', errorMessage: 'Messenger delivery is not configured', retryable: false };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://graph.facebook.com/${this.config.graphApiVersion}/${encodeURIComponent(this.config.pageId)}/messages`,
        {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${this.config.pageAccessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } }),
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return { success: false, errorCode: timedOut ? 'META_TIMEOUT' : 'META_NETWORK_ERROR', errorMessage: timedOut ? 'Messenger delivery timed out' : 'Messenger network request failed', retryable: true };
    }
    clearTimeout(timeout);
    let body: unknown;
    try { body = await response.json(); }
    catch { return { success: false, errorCode: 'META_MALFORMED_RESPONSE', errorMessage: 'Meta returned malformed JSON', retryable: response.status >= 500 }; }
    const result = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (!response.ok) {
      const failure = safeError(result);
      return { success: false, errorCode: failure.code, errorMessage: failure.message, retryable: response.status === 429 || response.status >= 500 || failure.transient, rawResponse: result };
    }
    const messageId = typeof result.message_id === 'string' ? result.message_id : undefined;
    if (!messageId) return { success: false, errorCode: 'META_MALFORMED_RESPONSE', errorMessage: 'Meta response omitted message_id', retryable: false, rawResponse: result };
    return { success: true, externalMessageId: messageId, rawResponse: result, retryable: false };
  }
}
