export type MessengerMessageType = 'text' | 'image' | 'audio' | 'unsupported';
export type MessengerEventType = 'message' | 'message_echo' | 'delivery' | 'read' | 'postback';

export interface NormalizedMessengerEvent {
  externalEventId: string;
  eventType?: MessengerEventType;
  messageId: string;
  senderId: string;
  pageId: string;
  timestamp: number;
  messageType: MessengerMessageType;
  text: string;
  attachmentUrl?: string;
  attachmentType?: string;
  mimeType?: string;
  deliveryMessageIds?: string[];
  watermark?: number;
  postbackPayload?: string;
}

export interface MessengerJobData {
  eventLogId: string;
  event: NormalizedMessengerEvent;
  requestId?: string;
  correlationId?: string;
}

export type MessengerErrorType =
  | 'AUTH_ERROR' | 'RATE_LIMIT' | 'NETWORK_ERROR' | 'PROVIDER_ERROR'
  | 'VALIDATION_ERROR' | 'WEBHOOK_ERROR' | 'AI_ERROR' | 'QUEUE_ERROR'
  | 'DATABASE_ERROR' | 'UNKNOWN_ERROR';

export interface MessengerSendResult {
  success: boolean;
  externalMessageId?: string;
  rawResponse?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  errorType?: MessengerErrorType;
  retryAfterMs?: number;
  uncertain?: boolean;
  retryable: boolean;
}

export interface MessengerOutgoingJobData {
  outgoingId: string;
  correlationId: string;
}
