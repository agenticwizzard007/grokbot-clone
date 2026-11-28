import path from 'node:path';
import { runDashboardPolish } from './demo-dash.mjs';

const before = process.argv.includes('--before');
await runDashboardPolish({ before, output: path.resolve(`.context/ui-custom/fix-dash-2/${before ? 'before' : 'after'}`) });
