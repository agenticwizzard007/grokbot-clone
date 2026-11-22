import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/**
 * R2F-019: request bodies for Bot, group and card answer routes are capped in bytes before any JSON is
 * parsed. The 32,000 character message cap stays as the readable limit; 256 KB leaves room for JSON
 * framing and multi-byte text. Bot setup imports carry a whole manifest and get a larger cap. None of
 * these routes accept file uploads (voice and avatar uploads live under other paths).
 */
export const API_BODY_LIMIT = 256 * 1024;
export const IMPORT_BODY_LIMIT = 2 * 1024 * 1024;
export const BODY_TOO_LARGE = 'Message is too long (max 32,000 characters).';
export const IMPORT_TOO_LARGE = 'This setup file is too large (max 2 MB).';

const standard = bodyLimit({ maxSize: API_BODY_LIMIT, onError: (c) => c.json({ error: BODY_TOO_LARGE }, 413) });
const imports = bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: (c) => c.json({ error: IMPORT_TOO_LARGE }, 413) });

export const apiBodyLimit: MiddlewareHandler = (c, next) => (/\/bots\/import\/?$/.test(c.req.path) ? imports(c, next) : standard(c, next));

/** Paths covered when mounting at the application root. */
export const BODY_LIMITED_PATHS = ['/api/bots', '/api/bots/*', '/api/rooms', '/api/rooms/*', '/api/approvals/*'] as const;
