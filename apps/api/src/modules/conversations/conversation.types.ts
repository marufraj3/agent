import type { Prisma } from '@alzeena/database';

export const conversationChannels = ['web', 'messenger', 'admin', 'test'] as const;
export type ConversationChannelName = (typeof conversationChannels)[number];
export const conversationStatuses = ['active', 'closed', 'human'] as const;
export type ConversationStatusName = (typeof conversationStatuses)[number];
export const messageRoles = ['user', 'assistant', 'system', 'human'] as const;
export type MessageRoleName = (typeof messageRoles)[number];
export const messageTypes = ['text', 'image', 'audio', 'system'] as const;
export type MessageTypeName = (typeof messageTypes)[number];

export const channelToPrisma = {
  web: 'WEB',
  messenger: 'MESSENGER',
  admin: 'ADMIN',
  test: 'TEST',
} as const;

export const statusToPrisma = {
  active: 'ACTIVE',
  closed: 'CLOSED',
  human: 'HUMAN',
} as const;

export const roleToPrisma = {
  user: 'USER',
  assistant: 'ASSISTANT',
  system: 'SYSTEM',
  human: 'HUMAN',
} as const;

export const messageTypeToPrisma = {
  text: 'TEXT',
  image: 'IMAGE',
  audio: 'AUDIO',
  system: 'SYSTEM',
} as const;

export type JsonMetadata = Prisma.InputJsonValue;
