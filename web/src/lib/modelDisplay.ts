/** Catalog wording wins, but versions are normalized even in catalog labels. */
export function modelDisplayName(id: string, catalogName?: string | null): string {
  const name = catalogName?.trim();
  const catalog = !!name && name !== id && !name.includes('/');
  let raw = (catalog ? name : id.split('/').pop() || '').trim();
  // Preserve the compact Claude release labels used by the picker.
  raw = raw.replace(/^((?:claude[-_][a-z]+|opus|sonnet|haiku)[-_]\d{1,2}(?:[-_.]\d{1,2})?)[-_]\d{8}$/i, '$1');
  const slug = !catalog || /^[a-z\d]+(?:[-_][a-z\d.]+)+$/.test(raw)
    || (!/\s/.test(raw) && /[a-z][-_]\d{1,2}[-_]\d{1,2}(?=$|[-_])/i.test(raw));
  // Dates are separate tokens, never major/minor pairs. A size or context suffix
  // (70b, 8x7b, 128k) cannot satisfy the boundary after the minor version.
  const model = raw.split(/((?<![a-z\d])\d{4}[-_ ]\d{2}[-_ ]\d{2}(?![a-z\d])|(?<![a-z\d])\d{8}(?![a-z\d]))/i).map((part, index) => {
    if (index % 2) return part.replace(/[_ ]/g, '-');
    const versioned = part.replace(/(?<![a-z\d])([a-z]+)([-_ ]*)(\d{1,2})[-_ ]+(\d{1,2})(?=$|[-_\s:()])/gi,
      (match, family: string, separator: string, major: string, minor: string) =>
        /^(preview|exp|experimental|release|date|context|size|tokens|experts|count|counts)$/i.test(family) ? match : `${family}${separator}${major}.${minor}`);
    return slug ? versioned.replace(/[-_]+/g, ' ') : versioned;
  }).join('').trim() || 'Model';
  if (!slug) return model;
  return model.replace(/\b[a-z][a-z0-9]*/gi, word => {
    if (/^(gpt|glm|llama|api)$/i.test(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}
