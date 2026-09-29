import type { NormalizedMessengerEvent } from './messenger.types.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class MessengerEventParser {
  parse(payload: unknown, configuredPageId?: string): NormalizedMessengerEvent[] {
    const root = record(payload);
    if (!root || root.object !== 'page' || !Array.isArray(root.entry)) return [];
    const events: NormalizedMessengerEvent[] = [];
    for (const rawEntry of root.entry) {
      const entry = record(rawEntry);
      if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.messaging)) continue;
      const pageId = entry.id;
      if (configuredPageId && pageId !== configuredPageId) continue;
      for (const rawMessaging of entry.messaging) {
        const messaging = record(rawMessaging);
        const sender = record(messaging?.sender);
        const recipient = record(messaging?.recipient);
        const message = record(messaging?.message);
        if (!messaging || !sender || !recipient || !message) continue;
        const senderId = typeof sender.id === 'string' ? sender.id : '';
        const recipientId = typeof recipient.id === 'string' ? recipient.id : '';
        if (!senderId || senderId === pageId || recipientId !== pageId || message.is_echo === true) continue;
        const messageId = typeof message.mid === 'string' ? message.mid : '';
        if (!messageId || messageId.length > 255) continue;
        const timestamp = typeof messaging.timestamp === 'number' ? messaging.timestamp : Date.now();
        const text = typeof message.text === 'string' ? message.text.trim().slice(0, 4_000) : '';
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const attachment = record(attachments[0]);
        const attachmentPayload = record(attachment?.payload);
        const attachmentType = typeof attachment?.type === 'string' ? attachment.type : 'unsupported';
        const mimeType = typeof attachmentPayload?.mime_type === 'string'
          ? attachmentPayload.mime_type.slice(0, 100).toLowerCase()
          : typeof attachmentPayload?.content_type === 'string'
            ? attachmentPayload.content_type.slice(0, 100).toLowerCase()
            : undefined;
        const url = typeof attachmentPayload?.url === 'string' && /^https:\/\//i.test(attachmentPayload.url)
          ? attachmentPayload.url
          : undefined;
        const messageType = attachmentType === 'image' && url
          ? 'image'
          : attachmentType === 'audio' && url
            ? 'audio'
            : text
              ? 'text'
              : 'unsupported';
        events.push({
          externalEventId: messageId,
          messageId,
          senderId,
          pageId,
          timestamp,
          messageType,
          text: messageType === 'unsupported' ? '[Unsupported Messenger attachment]' : text,
          attachmentUrl: url,
          attachmentType,
          ...(mimeType ? { mimeType } : {}),
        });
      }
    }
    return events;
  }
}
