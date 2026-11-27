import { uiConfigSchema, type UiConfig } from './schema.js';
export function migrate(raw: unknown): { doc: UiConfig; migrated: boolean } | { error: string } {
  const result = uiConfigSchema.safeParse(raw);
  return result.success ? { doc: result.data, migrated: false } : { error: 'Invalid appearance document.' };
}
