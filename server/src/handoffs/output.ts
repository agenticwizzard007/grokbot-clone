import type { OutputPart, SubmitOutputInput } from './contracts.js';
import { OUTPUT_LIMITS } from './contracts.js';
import { displayCoordinationText } from '../lib/redact.js';
import { canonicalJson, hashValue, sha256 } from '../flow/hash.js';
import { submitOutputSchema } from './schema.js';
import { HandoffError } from './errors.js';

/** Display redaction is deliberately separate from original storage. */
export function redactOutputText(text: string): string {
  return displayCoordinationText(text)
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{8,}/gi, '$1 [redacted]')
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}
export function summarizeOutput(body: string): string {
  const text = redactOutputText(body).trim();
  if (text.length <= OUTPUT_LIMITS.summaryChars) return text;
  const paragraph = text.split(/\n\s*\n/, 1)[0];
  if (paragraph.length <= OUTPUT_LIMITS.summaryChars) return paragraph;
  const head = paragraph.slice(0, OUTPUT_LIMITS.summaryChars);
  const sentences = [...head.matchAll(/[.!?](?:\s|$)/g)];
  return sentences.length ? head.slice(0, sentences.at(-1)!.index! + 1) : head.trimEnd();
}
export function extractLinks(body: string): Extract<OutputPart, { kind: 'link' }>[] {
  const links: Extract<OutputPart, { kind: 'link' }>[] = [], seen = new Set<string>();
  const add = (raw: string, title?: string) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || raw.length > 2048 || seen.has(url.href)) return;
      seen.add(url.href);
      links.push({ id: `p_link_${links.length + 1}`, kind: 'link', url: url.href, title: (title || url.hostname).slice(0, 120), relation: 'reference' });
    } catch { /* Not a link. */ }
  };
  for (const match of body.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>"\]]+)/g)) {
    add(match[2] || match[3].replace(/[.,;!?)]+$/, ''), match[1]);
    if (links.length === OUTPUT_LIMITS.linksMax) break;
  }
  return links;
}
export interface OutputContent {
  title: string; summary: string; parts: OutputPart[]; bodies: Record<string, string>;
  contentHash: string; truncated: boolean; redacted: boolean;
}
/** Hash content, not generated ids, so identical content across runs detects a stall. */
export function contentHash(parts: readonly OutputPart[], bodies: Readonly<Record<string, string>>): string {
  const manifest = parts.map(part => {
    const { id, ...rest } = part;
    if (rest.kind === 'file') { const { artifactId: _artifactId, ...file } = rest; return { ...file }; }
    return { ...rest, ...((part.kind === 'text' || part.kind === 'data') ? { body: bodies[id] ?? '' } : {}) };
  }).sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
  return hashValue(manifest);
}
export function buildOutputContent(body: string, declared?: SubmitOutputInput, files: Extract<OutputPart, { kind: 'file' }>[] = []): OutputContent {
  if (declared) {
    const valid = submitOutputSchema.safeParse(declared);
    if (!valid.success) throw new HandoffError('invalid_input', valid.error.message);
  }
  if (files.length > OUTPUT_LIMITS.filesMax) throw new HandoffError('size_limit', 'Too many files');
  const capped = body.slice(0, OUTPUT_LIMITS.bodyChars), display = redactOutputText(capped);
  const bodies: Record<string, string> = {}, parts: OutputPart[] = [];
  if (capped) { bodies.p_body = capped; parts.push({ id: 'p_body', kind: 'text', name: 'body', chars: capped.length, sha256: sha256(capped) }); }
  const summary = declared ? redactOutputText(declared.summary) : summarizeOutput(display);
  for (const [i, data] of (declared?.dataParts ?? []).entries()) {
    const text = canonicalJson(data.json), id = `p_data_${i + 1}`;
    bodies[id] = text;
    parts.push({ id, kind: 'data', name: data.name, ...(data.schema ? { schema: data.schema } : {}), bytes: new TextEncoder().encode(text).length, sha256: sha256(text) });
  }
  parts.push(...files);
  const urls = new Set<string>();
  for (const link of [...(declared?.links ?? []), ...extractLinks(capped)]) {
    if (urls.has(link.url) || urls.size >= OUTPUT_LIMITS.linksMax) continue;
    urls.add(link.url); parts.push({ ...link, id: `p_link_${urls.size}`, kind: 'link' });
  }
  return { title: redactOutputText(declared?.title ?? display.split('\n')[0] ?? '').slice(0, 120), summary, parts, bodies,
    contentHash: contentHash(parts, bodies), truncated: body.length > capped.length,
    redacted: display !== capped || summary !== (declared?.summary ?? summary) };
}
export type OutputReference = { kind: 'output'; outputId: string; partId?: string; offset?: number; limit?: number } | { kind: 'handoff'; handoffId: string };
export function parseReference(ref: string): OutputReference {
  const handoff = /^swarm:\/\/handoff\/(ho_[A-Za-z0-9_-]{1,150})$/.exec(ref);
  if (handoff) return { kind: 'handoff', handoffId: handoff[1] };
  const output = /^swarm:\/\/output\/(out_[A-Za-z0-9_-]{1,150})(?:#(p_[A-Za-z0-9_-]{1,150}))?(?:\?o=(\d+)&l=(\d+))?$/.exec(ref);
  if (!output) throw new HandoffError('invalid_input', 'Invalid handoff reference');
  const offset = output[3] === undefined ? undefined : Number(output[3]), limit = output[4] === undefined ? undefined : Number(output[4]);
  if ((offset !== undefined && !Number.isSafeInteger(offset)) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 8000))) throw new HandoffError('invalid_input', 'Invalid page range');
  return { kind: 'output', outputId: output[1], ...(output[2] ? { partId: output[2] } : {}), ...(offset === undefined ? {} : { offset, limit }) };
}
export function outputRef(outputId: string, partId?: string): string {
  const ref = `swarm://output/${outputId}${partId ? `#${partId}` : ''}`; parseReference(ref); return ref;
}
