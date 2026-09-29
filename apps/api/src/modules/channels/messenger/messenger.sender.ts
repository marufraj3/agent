import type { MessengerConfig } from './messenger.config.js';
import { MetaGraphClient } from './meta-graph.client.js';
import type { MessengerProvider } from './messenger.provider.js';
import type { MessengerSendResult } from './messenger.types.js';

export class MetaMessengerProvider implements MessengerProvider {
  private readonly client: MetaGraphClient;
  constructor(private readonly config: MessengerConfig, private readonly tokenResolver: (pageId: string) => Promise<string | undefined> = async () => config.pageAccessToken, fetchImpl: typeof fetch = fetch) {
    this.client = new MetaGraphClient(config.graphApiVersion, config.timeoutMs, fetchImpl);
  }
  async sendText(pageId: string, recipientId: string, text: string, messagingType: 'RESPONSE' | 'UPDATE' = 'RESPONSE'): Promise<MessengerSendResult> {
    const token = await this.tokenResolver(pageId);
    if (!pageId || !token) return { success: false, errorCode: 'MESSENGER_NOT_CONFIGURED', errorMessage: 'Messenger delivery is not configured', errorType: 'AUTH_ERROR', retryable: false };
    const result = await this.client.request(pageId, token, '/messages', { method: 'POST', body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: messagingType, message: { text } }) });
    if (result.success && !result.externalMessageId) return { success: false, errorCode: 'META_MALFORMED_RESPONSE', errorMessage: 'Meta response omitted message_id', errorType: 'PROVIDER_ERROR', retryable: false, rawResponse: result.rawResponse };
    return result;
  }
}

/** Compatibility facade. All Meta HTTP calls remain inside MetaGraphClient. */
export class MessengerSender {
  private readonly provider: MetaMessengerProvider;
  constructor(private readonly config: MessengerConfig, fetchImpl: typeof fetch = fetch) { this.provider = new MetaMessengerProvider(config, async () => config.pageAccessToken, fetchImpl); }
  sendText(recipientId: string, text: string, messagingType: 'RESPONSE' | 'UPDATE' = 'RESPONSE') {
    return this.provider.sendText(this.config.pageId ?? '', recipientId, text, messagingType);
  }
  sendForPage(pageId: string, recipientId: string, text: string, messagingType: 'RESPONSE' | 'UPDATE' = 'RESPONSE') {
    return this.provider.sendText(pageId, recipientId, text, messagingType);
  }
}
