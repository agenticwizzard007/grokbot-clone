import { db } from '../db.js';
import { hub } from '../lib/hub.js';
import { withRun } from '../agent/run-scope.js';
import { SqliteUiConfigService } from './service.js';
import { createUiApi } from './routes.js';

export { SqliteUiConfigService } from './service.js';
export const uiConfigService = new SqliteUiConfigService(db, { emit: (userId, event) => withRun(undefined, () => hub.emit(userId, event)) });
export const uiApi = createUiApi(uiConfigService);
