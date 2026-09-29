import type { FastifyInstance } from "fastify";
import { z, type ZodType } from "zod";
import { env } from "../../../config/env.js";
import { AppError } from "../../../errors/app-error.js";
import {
  knowledgeBaseUpdateSchema,
  quickReplySchema,
  quickReplyUpdateSchema,
  settingsUpdateSchema,
} from "../admin.schemas.js";
import { requireAdmin } from "../auth/require-admin.js";
import { isAdminPasswordValid } from "../auth/admin-password.js";
import { ADMIN_SESSION_COOKIE, adminCookie, createAdminSession } from "../auth/admin-session.js";
import { KnowledgeBaseService } from "../knowledge-base.service.js";
import { SettingsService } from "../settings.service.js";

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const message = result.error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
  throw new AppError(message, 400, "VALIDATION_ERROR");
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const knowledgeBase = new KnowledgeBaseService(app.prisma);
  const settings = new SettingsService(app.prisma);
  const protectedRoute = { preHandler: requireAdmin };
  const loginSchema = z.object({ password: z.string().min(1).max(512) }).strict();

  app.post('/api/admin/session', async (request, reply) => {
    if (!env.ADMIN_PASSWORD) throw new AppError('Admin operations are not configured', 503, 'ADMIN_NOT_CONFIGURED');
    const key = `rate:admin-login:${request.ip}`;
    const attempts = Number(await app.redis.get(key).catch(() => '0'));
    if (attempts >= env.ADMIN_LOGIN_RATE_LIMIT_PER_15_MINUTES) throw new AppError('Too many login attempts', 429, 'LOGIN_RATE_LIMITED');
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || !isAdminPasswordValid(parsed.success ? parsed.data.password : undefined, env.ADMIN_PASSWORD)) {
      const count = await app.redis.incr(key); if (count === 1) await app.redis.expire(key, 15 * 60);
      throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
    }
    await app.redis.del(key);
    const maxAge = env.ADMIN_SESSION_TTL_HOURS * 3600;
    reply.header('set-cookie', adminCookie(createAdminSession(env.ADMIN_PASSWORD, env.ADMIN_SESSION_TTL_HOURS), env.NODE_ENV === 'production', maxAge));
    return { success: true, data: { expiresInSeconds: maxAge } };
  });
  app.get('/api/admin/session', protectedRoute, async () => ({ success: true, data: { authenticated: true } }));
  app.delete('/api/admin/session', async (_request, reply) => {
    reply.header('set-cookie', `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return { success: true };
  });

  app.get("/api/admin/knowledge-base", protectedRoute, async () => {
    const active = await knowledgeBase.getActiveKnowledgeBase();
    return { success: true, data: active };
  });

  app.put("/api/admin/knowledge-base", protectedRoute, async (request) => {
    const body = parseBody(knowledgeBaseUpdateSchema, request.body);
    const updated = await knowledgeBase.updateKnowledgeBase(body.content);
    return { success: true, message: "Knowledge Base saved", data: updated };
  });

  app.get(
    "/api/admin/knowledge-base/versions",
    protectedRoute,
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
      return {
        success: true,
        data: await knowledgeBase.listVersions(page, limit),
      };
    },
  );
  app.get<{ Params: { version: string } }>(
    "/api/admin/knowledge-base/versions/:version",
    protectedRoute,
    async (request) => {
      const version = Number(request.params.version);
      if (!Number.isInteger(version) || version < 1)
        throw new AppError("Invalid version", 400, "VALIDATION_ERROR");
      const data = await knowledgeBase.getVersion(version);
      if (!data) throw new AppError("Version not found", 404, "NOT_FOUND");
      return { success: true, data };
    },
  );
  app.post<{ Params: { version: string } }>(
    "/api/admin/knowledge-base/versions/:version/restore",
    protectedRoute,
    async (request) => {
      const version = Number(request.params.version);
      if (!Number.isInteger(version) || version < 1)
        throw new AppError("Invalid version", 400, "VALIDATION_ERROR");
      try {
        return {
          success: true,
          message: `Version ${version} restored as a new version`,
          data: await knowledgeBase.restoreVersion(version),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "KNOWLEDGE_BASE_VERSION_NOT_FOUND"
        )
          throw new AppError("Version not found", 404, "NOT_FOUND");
        throw error;
      }
    },
  );

  app.get("/api/admin/settings", protectedRoute, async () => {
    const data = await settings.getBusinessSettings();
    return { success: true, data };
  });

  app.put("/api/admin/settings", protectedRoute, async (request) => {
    const body = parseBody(settingsUpdateSchema, request.body);
    const data = await settings.updateBusinessSettings(body);
    return { success: true, message: "Settings saved", data };
  });

  app.get("/api/admin/settings/ai", protectedRoute, async () => ({
    success: true,
    data: {
      model: env.GEMINI_MODEL,
      maxOutput: env.GEMINI_MAX_OUTPUT_TOKENS,
      temperature: env.GEMINI_TEMPERATURE,
      timeoutMs: env.GEMINI_TIMEOUT_MS,
      historyLimit: env.AI_MAX_HISTORY_MESSAGES,
      apiKey: {
        configured: Boolean(env.GEMINI_API_KEY),
        masked: env.GEMINI_API_KEY ? "••••••••" : null,
      },
      source: "environment",
      editable: false,
    },
  }));
  app.get("/api/admin/settings/secrets", protectedRoute, async () => ({
    success: true,
    data: {
      gemini: Boolean(env.GEMINI_API_KEY),
      facebookAppSecret: Boolean(env.FACEBOOK_APP_SECRET),
      facebookPageAccessToken: Boolean(env.FACEBOOK_PAGE_ACCESS_TOKEN),
      database: Boolean(env.DATABASE_URL),
      redis: Boolean(env.REDIS_URL),
    },
  }));

  const quickDb = app.prisma as any;
  app.get("/api/admin/quick-replies", protectedRoute, async (request) => {
    const includeDisabled = (request.query as any)?.includeDisabled === "true";
    const items = await quickDb.quickReply.findMany({
      where: includeDisabled ? {} : { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return { success: true, data: items };
  });
  app.post(
    "/api/admin/quick-replies",
    protectedRoute,
    async (request, reply) => {
      const body = parseBody(quickReplySchema, request.body);
      const data = await quickDb.quickReply.create({ data: body });
      return reply
        .code(201)
        .send({ success: true, message: "Quick reply created", data });
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/admin/quick-replies/:id",
    protectedRoute,
    async (request) => {
      const body = parseBody(quickReplyUpdateSchema, request.body);
      try {
        return {
          success: true,
          message: "Quick reply updated",
          data: await quickDb.quickReply.update({
            where: { id: request.params.id },
            data: body,
          }),
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2025"
        )
          throw new AppError("Quick reply not found", 404, "NOT_FOUND");
        throw error;
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/admin/quick-replies/:id",
    protectedRoute,
    async (request) => {
      try {
        await quickDb.quickReply.delete({ where: { id: request.params.id } });
        return { success: true, message: "Quick reply deleted" };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2025"
        )
          throw new AppError("Quick reply not found", 404, "NOT_FOUND");
        throw error;
      }
    },
  );
}
