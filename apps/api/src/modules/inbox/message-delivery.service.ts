export interface DeliveryMessage {
  conversationId: string;
  channel: 'WEB' | 'MESSENGER' | 'ADMIN' | 'TEST';
  recipientId: string | null;
  content: string;
}

export interface DeliveryResult {
  status: 'sent' | 'failed';
  provider: string;
  providerMessageId?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface MessageDeliveryProvider {
  readonly name: string;
  sendMessage(message: DeliveryMessage): Promise<DeliveryResult>;
}

export class TestMessageDeliveryProvider implements MessageDeliveryProvider {
  readonly name = 'local-test';
  async sendMessage(message: DeliveryMessage): Promise<DeliveryResult> {
    return { status: 'sent', provider: this.name, providerMessageId: `local:${message.conversationId}:${Date.now()}` };
  }
}

export class MessageDeliveryService {
  constructor(
    private readonly fallback: MessageDeliveryProvider = new TestMessageDeliveryProvider(),
    private readonly channelProviders: Partial<Record<DeliveryMessage['channel'], MessageDeliveryProvider>> = {},
  ) {}
  sendMessage(message: DeliveryMessage) {
    return (this.channelProviders[message.channel] ?? this.fallback).sendMessage(message);
  }
}
