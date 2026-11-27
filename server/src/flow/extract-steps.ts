export interface FlowSkill { id: string; name: string; body?: string }
export interface ExtractedStep { id: string; kind: 'step' | 'skill'; label: string; skillId?: string; order: number }
export function flowLabel(text: string, max = 40): string {
  let clean = text.replace(/[\u2013\u2014]/g, '-').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length > max) {
    clean = clean.slice(0, max);
    const space = clean.lastIndexOf(' '); if (space > 0) clean = clean.slice(0, space);
  }
  clean = clean.replace(/[.,;:!?\s-]+$/g, '');
  return clean ? clean[0].toLocaleUpperCase('en-US') + clean.slice(1) : '';
}
const heading = /^(?:#{1,3}\s*)?(?:steps?|process|workflow|how you work|responsibilit(?:y|ies)|routine)\b/i;
const item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/;
const imperative = /^(?:check|collect|draft|send|review|summarize|update|create|find|monitor|schedule|reply|post|compare|report)\b/i;
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export function extractSteps(instructions: string, skills: readonly (FlowSkill | string)[] = []): ExtractedStep[] {
  // Ignore fenced examples so sample lists do not become process steps.
  const lines = instructions.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '').split(/\r?\n/);
  let items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i].trim())) continue;
    const found: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#{1,6}\s+/.test(lines[j]) || (/^\S.*:\s*$/.test(lines[j]) && !item.test(lines[j])) || heading.test(lines[j].trim())) break;
      const match = item.exec(lines[j]); if (match) found.push(match[1]);
    }
    if (found.length) { items = found; break; }
  }
  if (!items.length) items = lines.flatMap(line => { const match = item.exec(line); return match ? [match[1]] : []; });
  if (!items.length) items = lines.join('\n').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => imperative.test(s));
  const result: ExtractedStep[] = items.slice(0, 6).map((label, i): ExtractedStep => ({ id: `steps:step:${i + 1}`, kind: 'step', label: flowLabel(label), order: i })).filter(s => s.label);
  const sorted = skills.map(skill => typeof skill === 'string' ? { id: skill, name: skill } : skill)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const skill of sorted) {
    if (result.length >= 6) break;
    const nameWords = words(skill.name);
    const covered = nameWords.length && items.some(text => {
      const set = new Set(words(text)); return nameWords.filter(w => set.has(w)).length / nameWords.length >= 0.8;
    });
    if (covered || result.some(s => s.skillId === skill.id)) continue;
    result.push({ id: `steps:skill:${skill.id}`, kind: 'skill', label: flowLabel(`Skill: ${skill.name}`), skillId: skill.id, order: result.length });
  }
  return result;
}
