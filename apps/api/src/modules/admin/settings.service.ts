import type { PrismaClient } from '@alzeena/database';
import type { SettingsUpdateInput } from './admin.schemas.js';

const SETTING_DEFINITIONS = {
  deliveryChargeDhaka: {
    key: 'delivery_charge_dhaka',
    defaultValue: '0',
    description: 'Dhaka delivery charge in BDT.',
    group: 'delivery',
  },
  deliveryChargeOutsideDhaka: {
    key: 'delivery_charge_outside_dhaka',
    defaultValue: '0',
    description: 'Outside-Dhaka delivery charge in BDT.',
    group: 'delivery',
  },
  returnDeliveryCharge: {
    key: 'return_delivery_charge',
    defaultValue: '0',
    description: 'Return delivery charge in BDT.',
    group: 'delivery',
  },
  websiteApiBaseUrl: {
    key: 'website_api_base_url',
    defaultValue: 'https://sells.alzeena.com.bd/public/api',
    description: 'Public website API base URL.',
    group: 'business',
  },
  pageId: {
    key: 'page_id',
    defaultValue: '3',
    description: 'Alzeena page ID.',
    group: 'business',
  },
  deliveryCompanyId: {
    key: 'delivery_company_id',
    defaultValue: '11',
    description: 'Delivery company ID.',
    group: 'business',
  },
  utmSource: {
    key: 'utm_source',
    defaultValue: 'AI',
    description: 'Order attribution UTM source.',
    group: 'business',
  },
  utmCampaign: {
    key: 'utm_campaign',
    defaultValue: 'Order From AI BOT',
    description: 'Order attribution UTM campaign.',
    group: 'business',
  },
} as const;

type SettingName = keyof typeof SETTING_DEFINITIONS;
export type BusinessSettings = Record<SettingName, string>;

export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getBusinessSettings(): Promise<BusinessSettings> {
    await this.prisma.setting.createMany({
      data: Object.values(SETTING_DEFINITIONS).map(({ key, defaultValue, description }) => ({
        key,
        value: defaultValue,
        description,
      })),
      skipDuplicates: true,
    });

    const rows = await this.prisma.setting.findMany({
      where: { key: { in: Object.values(SETTING_DEFINITIONS).map(({ key }) => key) } },
      select: { key: true, value: true },
    });
    const values = new Map(rows.map((row) => [row.key, row.value]));

    return Object.fromEntries(
      Object.entries(SETTING_DEFINITIONS).map(([name, definition]) => [
        name,
        values.get(definition.key) ?? definition.defaultValue,
      ]),
    ) as BusinessSettings;
  }

  async updateBusinessSettings(input: SettingsUpdateInput): Promise<BusinessSettings> {
    const entries = Object.entries(input) as [SettingName, string][];

    await this.prisma.$transaction(async (transaction) => {
      for (const [name, value] of entries) {
        const definition = SETTING_DEFINITIONS[name];
        await transaction.setting.upsert({
          where: { key: definition.key },
          create: { key: definition.key, value, description: definition.description },
          update: { value, description: definition.description },
        });
      }

      const groups = [...new Set(entries.map(([name]) => SETTING_DEFINITIONS[name].group))];
      await transaction.systemLog.create({
        data: {
          level: 'INFO',
          type: 'ADMIN_SETTINGS_UPDATED',
          event: 'ADMIN_SETTINGS_UPDATED',
          module: 'admin',
          message: 'Admin updated business settings',
          metadata: {
            action: 'settings.update',
            groups,
            keys: entries.map(([name]) => SETTING_DEFINITIONS[name].key),
            settingCount: entries.length,
            timestamp: new Date().toISOString(),
          },
        },
      });
    });

    return this.getBusinessSettings();
  }
}

export async function getBusinessSettings(prisma: PrismaClient): Promise<BusinessSettings> {
  return new SettingsService(prisma).getBusinessSettings();
}
