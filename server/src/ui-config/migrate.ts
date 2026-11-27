import { uiConfigSchema, LIMITS, type UiConfig } from './schema.js';
import { jsonSize } from './errors.js';
import { checkAccessibility } from './contrast.js';
/** Version 1 is the first published format. Future n-to-n+1 transforms go here. */
export const migrations: Record<number, (doc: unknown) => unknown> = {};
export function migrate(raw: unknown): { doc: UiConfig; migrated: boolean } | { error: string } {
  try {
    const bytes = jsonSize(raw);
    if (bytes === null || bytes > LIMITS.documentBytes) return { error: 'Invalid appearance document size or JSON values.' };
    if (!raw || typeof raw !== 'object' || !('version' in raw) || !Number.isInteger(raw.version)) return { error: 'Invalid appearance version.' };
    if (Number(raw.version) > 1) return { error: 'Your saved appearance needs a newer version. Using the default look.' };
    let doc: unknown = structuredClone(raw), version = Number(raw.version), migrated = false;
    while (version < 1) {
      const migration = migrations[version];
      if (!migration) return { error: 'Unsupported appearance version.' };
      doc = migration(doc); version++; migrated = true;
    }
    const result = uiConfigSchema.safeParse(doc);
    if (!result.success) return { error: 'Invalid appearance document.' };
    if (checkAccessibility(result.data).length) return { error: 'Saved appearance does not meet accessibility requirements.' };
    return { doc: result.data, migrated };
  } catch { return { error: 'Invalid appearance document.' }; }
}
