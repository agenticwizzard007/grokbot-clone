import type { UiConfig } from './schema.js';
export type PatchOp =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move'; from: string; path: string };
export type ErrorCode = 'invalid_patch' | 'invalid_value' | 'unknown_path' | 'limit_exceeded' | 'accessibility' | 'required_item' | 'stale_revision' | 'stale_preview' | 'preview_expired' | 'not_found' | 'disabled' | 'rate_limited';
export interface Violation { path: string; code: ErrorCode; message: string; hint?: string; ratio?: number; minimum?: number; suggested?: string }
export interface PatchContext { userId?: string; botIds?: readonly string[]; generateId?: (kind: 'dashboard' | 'widget') => string }
export type PatchResult = { ok: true; result: UiConfig; summary: string[]; warnings: Violation[]; idMap: Record<string, string> } | { ok: false; errors: Violation[] };
export type ResetScope = 'all' | 'appearance' | 'theme' | 'layout' | 'components' | 'dashboards' | 'dashboard';
export type PreviewStatus = 'pending' | 'applied' | 'discarded' | 'expired' | 'superseded';
export interface StoredPreview {
  id: string; userId: string; baseRevision: number; patch: PatchOp[]; result: UiConfig;
  summary: string[]; warnings: Violation[]; idMap: Record<string, string>; intent: string; actor: string;
  status: PreviewStatus; createdAt: number; expiresAt: number; revision?: number;
}
export type PreviewResult = { ok: true; previewId: string; baseRevision: number; summary: string[]; warnings: Violation[]; idMap: Record<string, string>; applied: false } | { ok: false; errors: Violation[] };
export type ApplyResult = { ok: true; doc: UiConfig; revision: number; summary: string[] } | { ok: false; errors: Violation[] };
export interface UiConfigService {
  get(userId: string): { doc: UiConfig; revision: number };
  preview(userId: string, ops: PatchOp[], opts: { intent: string; actor: string; autofix?: boolean }): PreviewResult;
  getPreview(userId: string, id: string): StoredPreview | null;
  applyPreview(userId: string, id: string, actor: string): ApplyResult;
  discardPreview(userId: string, id: string): void;
  patch(userId: string, ops: PatchOp[], expectedRevision: number, actor: string): ApplyResult;
  undo(userId: string, steps: number, actor: string): ApplyResult;
  reset(userId: string, scope: ResetScope, dashboardId?: string): PreviewResult;
  agentApplyMode(userId: string): 'ask' | 'auto';
  enabled(userId: string): boolean;
}
export interface UiPreviewCardBody { card: 'ui_preview'; previewId: string; title: string; lines: string[]; moreCount: number; warnings: string[]; status: PreviewStatus; revision?: number }
