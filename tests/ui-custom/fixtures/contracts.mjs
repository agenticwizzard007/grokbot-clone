import { tsImport } from 'tsx/esm/api';
import { requireModules } from './harness.mjs';

export async function contracts() {
  requireModules('server/src/ui-config/index.ts');
  return tsImport('../../../server/src/ui-config/index.ts', import.meta.url);
}
