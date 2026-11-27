import { z } from 'zod';
import { widgets } from '../fixtures/matrix.mjs';

// Discover string enum fields from the actual shared schemas so new enums cannot silently
// fall outside the fuzz suite. Widget options/params have their own strict registered schemas.
function enumPaths(schema, value, prefix = [], root = schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    return enumPaths(target, value, prefix, root);
  }
  const found = Array.isArray(schema.enum) && schema.enum.some(item => typeof item === 'string') || typeof schema.const === 'string' ? [prefix] : [];
  for (const [key, child] of Object.entries(schema.properties || {})) found.push(...enumPaths(child, value?.[key], [...prefix, key], root));
  if (schema.items && Array.isArray(value)) for (let i = 0; i < value.length; i++) found.push(...enumPaths(schema.items, value[i], [...prefix, i], root));
  for (const branch of [...schema.anyOf || [], ...schema.oneOf || [], ...schema.allOf || []]) found.push(...enumPaths(branch, value, prefix, root));
  return found;
}
export function fuzzTargets(shared) {
  const { DEFAULT_CONFIG, uiConfigSchema, WIDGET_OPTIONS, SOURCE_PARAMS } = shared;
  const doc = structuredClone(DEFAULT_CONFIG);
  doc.dashboards = [{ id: 'd_00000001', name: 'Fuzz fixture', icon: 'layout-dashboard', widgets: widgets() }];
  doc.layout.sidebar.hidden = ['usage'];
  doc.layout.pinned = [{ type: 'dashboard', id: 'd_00000001' }];
  const jsonSchema = z.toJSONSchema(uiConfigSchema, { io: 'input', unrepresentable: 'any' });
  const targets = enumPaths(jsonSchema, doc).filter(keys => ['layout', 'dashboards', 'components', 'keybindings'].includes(keys[0]));
  for (const [index, widget] of doc.dashboards[0].widgets.entries()) {
    if (WIDGET_OPTIONS?.[widget.type]) targets.push(...enumPaths(z.toJSONSchema(WIDGET_OPTIONS[widget.type], { io: 'input', unrepresentable: 'any' }), widget.options, ['dashboards', 0, 'widgets', index, 'options']));
    if (widget.source && SOURCE_PARAMS?.[widget.source.id]) targets.push(...enumPaths(z.toJSONSchema(SOURCE_PARAMS[widget.source.id], { io: 'input', unrepresentable: 'any' }), widget.source.params, ['dashboards', 0, 'widgets', index, 'source', 'params']));
  }
  const parameterSchemas = Object.entries(SOURCE_PARAMS).map(([name, schema]) => {
    const data = { ...(name.includes('series') || name === 'usage.summary' || name === 'runs.counts' ? { range: '7d' } : {}), ...(name === 'usage.series' ? { metric: 'cost' } : {}), ...(name === 'runs.series' ? { group: 'day' } : {}) };
    return { name, schema, data, paths: enumPaths(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), data) };
  });
  return { doc, parameterSchemas, paths: [...new Map(targets.map(keys => [JSON.stringify(keys), keys])).values()] };
}
