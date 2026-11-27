import { db } from '../db.js';
import { hub } from '../lib/hub.js';
import { currentRun, withRun } from '../agent/run-scope.js';
import { SqliteUiConfigService } from './service.js';
import { createUiApi } from './routes.js';

export { SqliteUiConfigService } from './service.js';
export const uiConfigService = new SqliteUiConfigService(db, {
  // A reset proposed by a Bot belongs to that conversation, like other previews.
  resetActor: () => currentRun()?.botId ? `agent:${currentRun()!.botId}` : 'reset',
  // Saved account state outlives an individual agent run, including expiry timers.
  emit: (userId, event) => withRun(undefined, () => hub.emit(userId, event)),
});
export const uiApi = createUiApi(uiConfigService);
