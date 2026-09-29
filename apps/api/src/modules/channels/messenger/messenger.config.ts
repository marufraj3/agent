import { env } from '../../../config/env.js';

export interface MessengerConfig {
  appId?: string;
  appSecret?: string;
  verifyToken?: string;
  pageId?: string;
  pageAccessToken?: string;
  graphApiVersion: string;
  timeoutMs: number;
}

export function getMessengerConfig(): MessengerConfig {
  return {
    appId: env.FACEBOOK_APP_ID,
    appSecret: env.FACEBOOK_APP_SECRET,
    verifyToken: env.FACEBOOK_VERIFY_TOKEN,
    pageId: env.FACEBOOK_PAGE_ID,
    pageAccessToken: env.FACEBOOK_PAGE_ACCESS_TOKEN,
    graphApiVersion: env.META_GRAPH_API_VERSION ?? env.FACEBOOK_GRAPH_API_VERSION,
    timeoutMs: env.FACEBOOK_SEND_TIMEOUT_MS,
  };
}

export function isMessengerConfigured(config = getMessengerConfig()): boolean {
  return Boolean(config.appId && config.appSecret && config.verifyToken && config.pageId && config.pageAccessToken);
}
