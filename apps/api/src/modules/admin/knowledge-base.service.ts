import { Prisma, type PrismaClient } from '@alzeena/database';

const MAX_TRANSACTION_ATTEMPTS = 3;

export interface ActiveKnowledgeBase {
  content: string;
  version: number;
  updatedAt: Date;
}

export class KnowledgeBaseService {
  constructor(private readonly prisma: PrismaClient) {}

  async getActiveKnowledgeBase(): Promise<ActiveKnowledgeBase | null> {
    return this.prisma.knowledgeBase.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
      select: { content: true, version: true, updatedAt: true },
    });
  }

  async updateKnowledgeBase(content: string): Promise<ActiveKnowledgeBase> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const [active, latestVersion] = await Promise.all([
              transaction.knowledgeBase.findFirst({
                where: { isActive: true },
                orderBy: { version: 'desc' },
                select: { id: true, version: true },
              }),
              transaction.knowledgeBase.aggregate({ _max: { version: true } }),
            ]);
            const version = (latestVersion._max.version ?? 0) + 1;

            if (active) {
              await transaction.knowledgeBase.update({
                where: { id: active.id },
                data: { isActive: false },
              });
            }

            const knowledgeBase = await transaction.knowledgeBase.create({
              data: { content, version, isActive: true },
              select: { content: true, version: true, updatedAt: true },
            });

            await transaction.systemLog.create({
              data: {
                level: 'INFO',
                type: 'ADMIN_KNOWLEDGE_BASE_UPDATED',
                message: 'Admin updated the active Knowledge Base',
                metadata: {
                  action: 'knowledge_base.update',
                  version,
                  previousVersion: active?.version ?? null,
                  contentLength: content.length,
                  timestamp: knowledgeBase.updatedAt.toISOString(),
                },
              },
            });

            return knowledgeBase;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code);
        if (!retryable || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    }

    throw new Error('Knowledge Base update failed after transaction retries');
  }
}

export async function getActiveKnowledgeBase(
  prisma: PrismaClient,
): Promise<ActiveKnowledgeBase | null> {
  return new KnowledgeBaseService(prisma).getActiveKnowledgeBase();
}
