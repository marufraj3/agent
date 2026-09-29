import type { MessageDeliveryProvider, DeliveryMessage, DeliveryResult } from '../../inbox/message-delivery.service.js';
import { MessengerSender } from './messenger.sender.js';

export class MessengerMessageDeliveryProvider implements MessageDeliveryProvider {
  readonly name = 'facebook-messenger';
  constructor(private readonly sender: MessengerSender) {}
  async sendMessage(message: DeliveryMessage): Promise<DeliveryResult> {
    if (!message.recipientId) return { status: 'failed', provider: this.name, errorCode: 'MISSING_RECIPIENT', retryable: false };
    const result = await this.sender.sendText(message.recipientId, message.content);
    return result.success
      ? { status: 'sent', provider: this.name, providerMessageId: result.externalMessageId, retryable: false }
      : { status: 'failed', provider: this.name, errorCode: result.errorCode, retryable: result.retryable };
  }
}
