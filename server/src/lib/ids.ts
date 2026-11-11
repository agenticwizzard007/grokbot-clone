import crypto from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
// Secrets are pasted into shell commands as `--token <secret>`. A base64url value can begin
// with '-' (1 in 64), which argument parsers read as another option, so redraw those.
export const token = () => {
  for (;;) {
    const value = crypto.randomBytes(32).toString('base64url');
    if (!value.startsWith('-')) return value;
  }
};
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
