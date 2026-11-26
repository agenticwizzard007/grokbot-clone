/** Catalog labels win. Missing/loading catalogs still show readable model names. */
export function modelDisplayName(id: string, catalogName?: string | null): string {
  const name = catalogName?.trim();
  const claudeIdName = !!name && /^claude[-_](opus|sonnet|haiku)[-_]\d/i.test(name);
  if (name && name !== id && !name.includes('/') && !claudeIdName) return name;
  // Claude CLI ids encode major/minor with hyphens. Strip only an eight-digit
  // release date before joining the version, so it cannot become a minor version.
  const raw = (claudeIdName ? name : id).split('/').pop() || '';
  const claude = raw.match(/^(claude[-_])?(opus|sonnet|haiku)[-_](\d+)(?:[-_](\d{1,2}))?(?:[-_]\d{8})?$/i);
  const model = (claude
    ? `${claude[1] ? 'Claude ' : ''}${claude[2]} ${claude[3]}${claude[4] ? `.${claude[4]}` : ''}`
    : raw.replace(/[-_]+/g, ' ')).trim() || 'Model';
  return model.replace(/\b[a-z][a-z0-9]*/gi, word => {
    if (/^(gpt|glm|llama|api)$/i.test(word)) return word.toUpperCase();
    if (/^\d/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}
