import { buildApp } from './app.js';
import { env } from './config/env.js';

async function start(): Promise<void> {
  const app = await buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    const deadline = setTimeout(() => {
      app.log.error('Graceful shutdown deadline exceeded');
      process.exit(1);
    }, 30_000);
    deadline.unref();
    await app.close();
    clearTimeout(deadline);
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
  } catch (error) {
    app.log.fatal({ err: error }, 'Failed to start API');
    process.exit(1);
  }
}

void start();
