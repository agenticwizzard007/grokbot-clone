import type Database from 'better-sqlite3';

export type UsageKeyKind = 'native' | 'personal' | 'subscription';

/** Retained provider_connections rows include disabled and disconnected keys. */
export function migrateUsageKeyKind(db: Database.Database) {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[];
    if (columns.some(column => column.name === 'key_kind')) return;
    db.exec("ALTER TABLE usage_events ADD COLUMN key_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(key_kind IN ('native','personal','subscription','unknown'))");
    db.exec(`UPDATE usage_events SET key_kind = CASE
      WHEN cost_source='subscription' THEN 'subscription'
      WHEN user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id=usage_events.user_id)
        AND NOT EXISTS (SELECT 1 FROM provider_connections WHERE user_id=usage_events.user_id AND provider='openrouter') THEN 'native'
      ELSE 'unknown' END`);
  })();
}

// Private metadata, never sent to providers or serialized into model output.
const responseKeys = new WeakMap<object, { keyKind: UsageKeyKind; provider: string }>();
export const responseUsageKey = (response: unknown) => response && typeof response === 'object' ? responseKeys.get(response) : undefined;

/** Capture the credential selected by the client, including streaming final responses. */
export function attributedResponseCreate(create: (body: any, options?: any) => PromiseLike<any>, keyKind: UsageKeyKind, provider: string) {
  const tag = (response: any) => {
    if (response && typeof response === 'object') responseKeys.set(response, { keyKind, provider });
    return response;
  };
  return async (body: any, options?: any): Promise<any> => {
    const response = await create(body, options);
    if (!body.stream) return tag(response);
    const events = (async function* () {
      for await (const event of response) {
        tag(event.response);
        yield event;
      }
    })();
    return Object.assign(events, { controller: response.controller });
  };
}
