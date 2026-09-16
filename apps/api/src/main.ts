/**
 * API entry point. Configuration comes from the environment by NAME only; no secret is ever defaulted to a
 * usable value, so a missing variable fails loudly instead of starting an insecure server.
 */
import { configFromEnv, createPool } from '@yeonjae/db';
import { buildApi } from './server.js';

const pool = createPool(configFromEnv());
const app = buildApi({
  pool,
  // Secure cookies unless explicitly disabled for local HTTP development.
  secureCookies: process.env.YEONJAE_INSECURE_COOKIES !== 'true',
  logger: true,
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
