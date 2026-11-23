/** Catalog labels win. Missing/loading catalogs still show readable model names. */
export function modelDisplayName(id: string, catalogName?: string | null): string {
  const name = catalogName?.trim();
  if (name && name !== id && !name.includes('/')) return name;
  const model = id.split('/').pop()?.replace(/[-_]+/g, ' ').trim() || 'Model';
  return model.replace(/\b[a-z][a-z0-9]*/gi, word => {
    if (/^(gpt|glm|llama|api)$/i.test(word)) return word.toUpperCase();
    if (/^\d/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}
