import { randomUUID } from 'node:crypto';
import type { MessengerSendResult } from './messenger.types.js';

export interface MessengerProvider {
  sendText(pageId: string, recipientId: string, text: string, messagingType?: 'RESPONSE' | 'UPDATE'): Promise<MessengerSendResult>;
}

export class MockMessengerProvider implements MessengerProvider {
  readonly deliveries: Array<{ pageId: string; recipientId: string; text: string }> = [];
  async sendText(pageId: string, recipientId: string, text: string): Promise<MessengerSendResult> {
    this.deliveries.push({ pageId, recipientId, text });
    return { success: true, externalMessageId: `mock-${randomUUID()}`, retryable: false };
  }
}
