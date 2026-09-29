import { Prisma, type PrismaClient } from '@alzeena/database';
import type { JsonMetadata } from './conversation.types.js';

export interface CreateCustomerInput {
  externalId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  platform?: string | null;
  platformPageId?: string | null;
  platformUserId?: string | null;
  language?: string | null;
  metadata?: JsonMetadata;
}

export interface FindCustomerInput {
  id?: string;
  externalId?: string;
  platform?: string;
  platformPageId?: string;
  platformUserId?: string;
}

function clean(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed || null;
}

function customerData(input: CreateCustomerInput) {
  return {
    externalId: clean(input.externalId),
    name: clean(input.name),
    phone: clean(input.phone),
    email: clean(input.email)?.toLowerCase(),
    address: clean(input.address),
    platform: clean(input.platform)?.toLowerCase(),
    platformPageId: clean(input.platformPageId),
    platformUserId: clean(input.platformUserId),
    language: clean(input.language)?.toLowerCase(),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

export class CustomerService {
  constructor(private readonly prisma: PrismaClient) {}

  createCustomer(input: CreateCustomerInput) {
    return this.prisma.customer.create({ data: customerData(input) });
  }

  async findCustomer(input: FindCustomerInput) {
    if (input.id) return this.prisma.customer.findUnique({ where: { id: input.id } });
    if (input.externalId) {
      return this.prisma.customer.findUnique({ where: { externalId: input.externalId } });
    }
    if (input.platform && input.platformUserId) {
      return this.getCustomerByPlatformUserId(input.platform, input.platformUserId, input.platformPageId);
    }
    return null;
  }

  async findOrCreateCustomer(input: CreateCustomerInput) {
    const data = customerData(input);
    if (data.platform && data.platformUserId) {
      const platformPageId = data.platformPageId ?? 'global';
      return this.prisma.customer.upsert({
        where: {
          platform_platformPageId_platformUserId: {
            platform: data.platform,
            platformPageId,
            platformUserId: data.platformUserId,
          },
        },
        create: { ...data, platformPageId },
        update: {
          ...(data.externalId !== undefined ? { externalId: data.externalId } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.phone !== undefined ? { phone: data.phone } : {}),
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.address !== undefined ? { address: data.address } : {}),
          ...(data.language !== undefined ? { language: data.language } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        },
      });
    }
    if (data.externalId) {
      return this.prisma.customer.upsert({
        where: { externalId: data.externalId },
        create: data,
        update: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.phone !== undefined ? { phone: data.phone } : {}),
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.address !== undefined ? { address: data.address } : {}),
          ...(data.language !== undefined ? { language: data.language } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        },
      });
    }
    return this.createCustomer(input);
  }

  updateCustomer(id: string, input: Partial<CreateCustomerInput>) {
    return this.prisma.customer.update({ where: { id }, data: customerData(input) });
  }

  getCustomerByPlatformUserId(platform: string, platformUserId: string, platformPageId = 'global') {
    return this.prisma.customer.findUnique({
      where: {
        platform_platformPageId_platformUserId: {
          platform: platform.trim().toLowerCase(),
          platformPageId: platformPageId.trim(),
          platformUserId: platformUserId.trim(),
        },
      },
    });
  }

  isUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
