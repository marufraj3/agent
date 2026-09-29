import type { PrismaClient } from '@alzeena/database';
import { z } from 'zod';

export const automationSettingsSchema = z.object({
  enabled: z.boolean(), abandonedOrderDelayMinutes: z.number().int().min(30).max(1440),
  confirmationReminderDelayMinutes: z.number().int().min(30).max(1440), maximumFollowUpsPerConversation: z.number().int().min(1).max(5),
  minimumFollowUpIntervalMinutes: z.number().int().min(30).max(10080), timezone: z.literal('Asia/Dhaka'), humanHandoverBlock: z.boolean(),
  enabledOrderNotifications: z.array(z.enum(['CONFIRMED','CANCELLED'])).max(2),
}).strict();
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;

const defaults: AutomationSettings = { enabled: true, abandonedOrderDelayMinutes: 60, confirmationReminderDelayMinutes: 30, maximumFollowUpsPerConversation: 2, minimumFollowUpIntervalMinutes: 360, timezone: 'Asia/Dhaka', humanHandoverBlock: true, enabledOrderNotifications: [] };
const key = 'automation_settings';
export class AutomationSettingsService {
  constructor(private readonly prisma: PrismaClient) {}
  async get(): Promise<AutomationSettings> {
    const row = await (this.prisma as any).setting.findUnique({ where: { key } });
    if (!row) { await (this.prisma as any).setting.create({ data: { key, value: JSON.stringify(defaults), description: 'Customer journey automation settings.' } }); return defaults; }
    try { return automationSettingsSchema.parse(JSON.parse(row.value)); } catch { return defaults; }
  }
  async update(value: unknown): Promise<AutomationSettings> {
    const parsed = automationSettingsSchema.parse(value);
    await (this.prisma as any).setting.upsert({ where: { key }, create: { key, value: JSON.stringify(parsed), description: 'Customer journey automation settings.' }, update: { value: JSON.stringify(parsed) } });
    return parsed;
  }
}
