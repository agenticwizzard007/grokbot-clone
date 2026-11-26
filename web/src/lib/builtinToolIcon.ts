/** Internal actions have no connected-app identity. Unknown actions stay neutral. */
export function builtinToolIcon(tool: string) {
  const name = tool.trim().toLowerCase();
  if (/(^|_)skills?($|_|:)/.test(name)) return 'skill';
  if (/^(remember|forget)$|(^|_)memor(y|ies)($|_|:)/.test(name)) return 'memory';
  if (/(^|_)tasks?($|_|:)/.test(name)) return 'task';
  if (/(^|_)routines?($|_|:)|^set_checkins$/.test(name)) return 'routine';
  if (/(^|_)(file|files|artifact|deliverables?)($|_|:)/.test(name)) return 'file';
  if (/(^|_)browser($|_|:)/.test(name)) return 'browser';
  if (/^computer($|_)|^shell$/.test(name)) return 'computer';
  if (/^session_search$|(^|_)(chat|chats|search)($|_|:)/.test(name)) return 'search';
  return 'generic';
}
