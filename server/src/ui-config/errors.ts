import type { z } from 'zod';
import type { ErrorCode, Violation } from './service.js';
export function violation(path: string, code: ErrorCode, message: string, hint?: string): Violation { return { path, code, message, ...(hint ? { hint } : {}) }; }
export function pointer(parts: readonly PropertyKey[]): string { return parts.length ? '/' + parts.map(x => String(x).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : ''; }
export function schemaErrors(error: z.ZodError): Violation[] {
  return error.issues.flatMap(issue => {
    const code: ErrorCode = (issue as { params?: { code: ErrorCode } }).params?.code ?? (issue.code === 'too_big' ? 'limit_exceeded' : 'invalid_value');
    if (issue.code === 'unrecognized_keys') return issue.keys.map(key => violation(pointer([...issue.path, key]), 'unknown_path', 'Unknown configuration key.', 'Use an id from REGISTRY.'));
    return [violation(pointer(issue.path), code, issue.code === 'custom' ? issue.message : 'Value does not match the allowed schema.')];
  });
}
// Reject non-JSON values before cloning or serializing; property accessors are not evaluated.
export function jsonSize(value: unknown, maxDepth = 12): number | null {
  const seen = new Set<object>();
  function valid(v: unknown, depth: number): boolean {
    if (depth > maxDepth) return false;
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'object' || seen.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return false;
    seen.add(v);
    if (Object.getOwnPropertySymbols(v).length) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const ok = Object.entries(descriptors).every(([k, d]) => Array.isArray(v) && k === 'length' || ('value' in d && d.enumerable && !['__proto__', 'prototype', 'constructor'].includes(k) && valid(d.value, depth + 1)));
    const dense = !Array.isArray(v) || Object.keys(v).length === v.length;
    seen.delete(v); return ok && dense;
  }
  try { return valid(value, 0) ? new TextEncoder().encode(JSON.stringify(value)).length : null; } catch { return null; }
}
