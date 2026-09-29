import { createHash } from 'node:crypto';
import type { MessengerEventType, NormalizedMessengerEvent } from './messenger.types.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function idFor(type: MessengerEventType, pageId: string, senderId: string, timestamp: number, detail: string) {
  return `${type}:${createHash('sha256').update(`${pageId}:${senderId}:${timestamp}:${detail}`).digest('hex')}`;
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
        const messaging = record(rawMessaging); const sender = record(messaging?.sender); const recipient = record(messaging?.recipient);
        if (!messaging || !sender || !recipient) continue;
        const senderId = typeof sender.id === 'string' ? sender.id : '';
        const recipientId = typeof recipient.id === 'string' ? recipient.id : '';
        const timestamp = typeof messaging.timestamp === 'number' ? messaging.timestamp : Date.now();
        if (!senderId || !recipientId) continue;

        const delivery = record(messaging.delivery);
        if (delivery) {
          const mids = Array.isArray(delivery.mids) ? delivery.mids.filter((mid): mid is string => typeof mid === 'string').slice(0, 100) : [];
          const watermark = typeof delivery.watermark === 'number' ? delivery.watermark : timestamp;
          events.push({ externalEventId: idFor('delivery', pageId, senderId, watermark, mids.join(',')), eventType: 'delivery', messageId: mids[0] ?? '', senderId, pageId, timestamp, messageType: 'unsupported', text: '', deliveryMessageIds: mids, watermark });
          continue;
        }
        const read = record(messaging.read);
        if (read) {
          const watermark = typeof read.watermark === 'number' ? read.watermark : timestamp;
          events.push({ externalEventId: idFor('read', pageId, senderId, watermark, ''), eventType: 'read', messageId: '', senderId, pageId, timestamp, messageType: 'unsupported', text: '', watermark });
          continue;
        }
        const postback = record(messaging.postback);
        if (postback) {
          const payloadText = typeof postback.payload === 'string' ? postback.payload.slice(0, 2_000) : '';
          const mid = typeof postback.mid === 'string' ? postback.mid : idFor('postback', pageId, senderId, timestamp, payloadText);
          events.push({ externalEventId: mid, eventType: 'postback', messageId: mid, senderId, pageId, timestamp, messageType: 'text', text: payloadText || '[Messenger postback]', postbackPayload: payloadText });
          continue;
        }

        const message = record(messaging.message);
        if (!message) continue;
        const messageId = typeof message.mid === 'string' ? message.mid : '';
        if (!messageId || messageId.length > 255) continue;
        const echo = message.is_echo === true || senderId === pageId || recipientId !== pageId;
        const text = typeof message.text === 'string' ? message.text.trim().slice(0, 4_000) : '';
        if (echo) {
          events.push({ externalEventId: idFor('message_echo', pageId, senderId, timestamp, messageId), eventType: 'message_echo', messageId, senderId, pageId, timestamp, messageType: 'text', text });
          continue;
        }
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const attachment = record(attachments[0]); const attachmentPayload = record(attachment?.payload);
        const attachmentType = typeof attachment?.type === 'string' ? attachment.type : 'unsupported';
        const mimeType = typeof attachmentPayload?.mime_type === 'string' ? attachmentPayload.mime_type.slice(0, 100).toLowerCase() : typeof attachmentPayload?.content_type === 'string' ? attachmentPayload.content_type.slice(0, 100).toLowerCase() : undefined;
        const url = typeof attachmentPayload?.url === 'string' && /^https:\/\//i.test(attachmentPayload.url) ? attachmentPayload.url : undefined;
        const messageType = attachmentType === 'image' && url ? 'image' : attachmentType === 'audio' && url ? 'audio' : text ? 'text' : 'unsupported';
        events.push({ externalEventId: messageId, eventType: 'message', messageId, senderId, pageId, timestamp, messageType, text: messageType === 'unsupported' ? '[Unsupported Messenger attachment]' : text, attachmentUrl: url, attachmentType, ...(mimeType ? { mimeType } : {}) });
      }
    }
    return events;
  }
}
