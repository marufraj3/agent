export type MessengerMessageType = 'text' | 'image' | 'audio' | 'unsupported';

export interface NormalizedMessengerEvent {
  externalEventId: string;
  messageId: string;
  senderId: string;
  pageId: string;
  timestamp: number;
  messageType: MessengerMessageType;
  text: string;
  attachmentUrl?: string;
  attachmentType?: string;
  mimeType?: string;
}

export interface MessengerJobData {
  eventLogId: string;
  event: NormalizedMessengerEvent;
  requestId?: string;
}

export interface MessengerSendResult {
  success: boolean;
  externalMessageId?: string;
  rawResponse?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}
