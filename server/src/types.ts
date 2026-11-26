import type { ConnectionDetails } from './connection-details.js';
// Shared API contract between server and web (web imports these as types only).
import type { BirdAvatarShape } from './avatar-shapes.js';

export type AvatarShape =
  | BirdAvatarShape
  | 'blob' | 'pebble' | 'bean' | 'egg' | 'squircle' | 'tablet' | 'capsule' | 'cylinder' | 'hex'
  | 'gem' | 'crystal' | 'wedge' | 'shield' | 'dome' | 'arch' | 'cloud' | 'teardrop' | 'leaf'
  | 'square' | 'sparkle' | 'clover' | 'flower' | 'heart' | 'house' | 'star';

export type AvatarColor =
  | 'black' | 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'gray';

export interface User { id: string; email: string; name: string; avatarUrl: string | null }

export interface McpServerView {
  id: string; name: string; transport: 'http' | 'sse' | 'stdio';
  url: string; command: string; args: string[]; cwd: string;
  folders: string[];
  enabled: boolean; botIds: string[] | null; requireApproval: boolean;
  oauth?: boolean;
  hasBearerToken: boolean; headerNames: string[]; envNames: string[];
  checkedAt: number | null; error: string | null;
  tools: { name: string; description: string; toolName: string }[];
}
export type McpServerInput = Pick<McpServerView, 'name' | 'transport' | 'url' | 'command' | 'args' | 'cwd' | 'enabled' | 'botIds' | 'requireApproval'> & {
  bearerToken?: string; headers?: Record<string, string>; env?: Record<string, string>; oauth?: boolean; folders?: string[];
};

export interface AgentBrief {
  purpose: string;
  responsibilities: string[];
  out_of_scope: string[];
  success_criteria: string[];
  context_summary: string;
  shared_resources: string[];
  handoff_notes: string[];
  communication_style: string;
  working_principles: string[];
  action_boundaries: string;
  workflows: { name: string; trigger: string; steps: string[]; output: string }[];
  open_questions: string[];
}

export interface AgentSetupView {
  manifest: { format: string; version: number; brief: AgentBrief; bot: { name: string; label: string; instructions: string }; source?: { creatorBotId?: string; generation?: number; messages: { seq: number; text: string }[]; sourceRefs?: { botId: string; generation: number; seq: number; contentHash: string; text: string }[] } };
  computer: { status: 'pending' | 'ready'; error: string | null };
  onboarding: { status: 'interviewing' | 'review' | 'active'; revision: number; confirmedAt: number | null; missing: string[] };
  files: Record<string, string>;
}

export interface CoworkerSetupView extends AgentSetupView { botId: string }

export interface AgentInstructionPreview {
  instructions: string;
  stage: 'interviewing' | 'review' | 'active';
  revision: number | null;
  capturedAt: number;
}

export interface Bot {
  suggestedApps?: import('./suggestion-snapshot.js').SuggestionSnapshot;
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  /** 'room' = group chat (members answer instead of the bot itself). */
  kind?: 'agent' | 'room';
  pinned: boolean;
  effort: Effort;
  /** OpenRouter only: route to the fastest providers (the model's ":nitro" variant). */
  fast: boolean;
  /** This Bot's model, or null for the server default (Settings → API keys). */
  model: string | null;
  /** Voice chat settings: direct provider voice id, speed multiplier (0.7–1.5), BCP-47 language or 'auto'. */
  voice: string;
  voiceSpeed: number;
  voiceLanguage: string;
  generation: number;
  unread: number;
  lastPreview: string | null;
  lastActivityAt: number;
  createdAt: number;
  /** Setup state; 'active' when the Bot has no pending setup interview. */
  onboarding?: { status: 'interviewing' | 'review' | 'active'; revision?: number };
}

/** A transcript row. `seq` orders rows; `updatedSeq` is a per-bot revision counter (rows are rewritten while streaming). */
export interface Row {
  audience?: 'user'|'internal';
  botId: string;
  generation: number;
  seq: number;
  updatedSeq: number;
  kind: RowKind;
  body: RowBody;
  createdAt: number;
}

export type RowKind = 'message' | 'tool-call' | 'card' | 'event' | 'notice';

export type RowBody = (
  | MessageBody
  | ToolCallBody
  | CardBody
  | EventBody
  | NoticeBody) & { audience?: 'user'|'internal'; jobId?: string };

export interface MessageBody {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  interrupted?: boolean;
  /** Set when a message came from another bot, a routine, a voice call or a text message rather than the user typing in the app. */
  from?: { kind: 'bot' | 'routine' | 'voice' | 'imessage' | 'sms' | 'whatsapp'; id: string; name: string; utteranceId?: string };
  citations?: { url: string; title?: string }[];
  /** The opening setup greeting; a rename rewrites it to the new name. */
  greeting?: boolean;
}

export interface ToolCallBody {
  type: 'tool-call';
  callId: string;
  name: string;
  /** Human phrase, e.g. "Clicking on screen". */
  label: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'awaiting-approval' | 'denied' | 'interrupted' | 'uncertain';
  /** Decision for this exact call, independent of execution progress. */
  approval?: { id: string; status: ApprovalStatus };
  startedAt?: number;
  completedAt?: number;
  args?: unknown;
  summary?: string;
  /** Data URL thumbnail for computer actions. */
  screenshot?: string;
}

export type ApprovalStatus = 'pending' | 'allowed' | 'always' | 'denied' | 'expired';

export type CardBody =
  | {
      type: 'card';
      card: 'approval';
      approvalId: string;
      /** Helper-owned approval shown in a visible parent conversation. */
      approvalSourceBotId?: string;
      /** Durable run that requested the decision, used to follow continuations. */
      jobId?: string;
      title: string;
      detail: string;
      /** Verified connected account label, separate from the exact action arguments. */
      accountLabel?: string;
      tool: string;
      toolkit?: string;
      toolkitName?: string;
      logo?: string;
      args: unknown;
      status: ApprovalStatus;
    }
  | {
      type: 'card';
      card: 'question';
      question: string;
      jobId?: string;
      answerJobId?: string;
      options: string[];
      status: 'pending' | 'answered' | 'dismissed';
      answer?: string;
    }
  | {
      type: 'card';
      card: 'connect';
      jobId?: string;
      answerJobId?: string;
      toolkit: string;
      toolkitName: string;
      logo?: string;
      reason: string;
      connectedAccountId?: string;
      accountDetails?: ConnectionDetails;
      connectionAttempt?: string;
      status: 'pending' | 'connected' | 'skipped' | 'expired';
    }
  | {
      type: 'card';
      card: 'draft';
      channel: 'email' | 'slack' | 'message';
      to: string;
      subject?: string;
      text: string;
      approvalId: string;
      status: 'pending' | 'sent' | 'discarded';
    };

export interface EventBody {
  type: 'event';
  event: 'routine-created' | 'routine-updated' | 'routine-run' | 'task-changed' | 'bot-message' | 'conversation-cleared' | 'computer' | 'voice-call' | 'setup-saved';
  text: string;
  ref?: string;
  /** voice-call only: the call record (set on the end-of-call row). */
  call?: VoiceCallRecord;
}

export interface VoiceCallRecord {
  id: string;
  phase: 'started' | 'ended';
  durationMs?: number;
  summary?: string;
  /** Structured end-of-call facts. Approval status is resolved when serialized. */
  baseText?: string;
  discussion?: string;
  approvals?: VoiceApprovalReference[];
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  tasks?: string[];
}

export interface VoiceApprovalReference {
  approvalId: string;
  botId: string;
  generation: number;
  rowSeq: number;
  botName: string;
  /** Exact subject from saved arguments, or the saved card title. */
  detail: string;
}

export interface VoiceOption { id: string; name: string; gender?: string }

export interface NoticeBody {
  type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error';
  /** Terminal runs must not retain an empty pending reply. Retry starts a fresh user request. */
  terminal?: boolean;
  retry?: { text: string };
  credits?: { provider: string; billingUrl?: string; details: string };
  /** A durable snapshot keeps the affected activity available after transcript paging. */
  recovery?: { jobId: string; activity: Pick<ToolCallBody, 'label' | 'status' | 'summary'>[] };
}

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering' | 'queued';

export interface LiveState {
  /** Durable job identity and monotonically increasing live-state revision. */
  runId?: string;
  revision?: number;
  audience?: 'user'|'internal';
  botId: string;
  isRunning: boolean;
  activity: { kind: ActivityKind; detail?: string; since: number } | null;
  awaiting: { reason: string; since: number } | null;
  startedAt: number | null;
}

export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string;
  activationPending?: boolean; activationError?: string | null; activationTarget?: boolean | null;
}

export interface Task { id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number }

export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }

export interface LibraryFile { name: string; size: number; modifiedAt: number; isDir: boolean }

export interface ComputerState {
  status: 'absent' | 'creating' | 'starting' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error' | 'stopped';
  orgoId: string | null;
  error: string | null;
  screens: { botId: string; screenId: string }[];
  /** Which kind of computer this is: an Orgo cloud VM, or a browser on the user's own PC. */
  provider?: 'orgo' | 'local' | 'cloudvm';
  /** For 'local': the connected PC. */
  device?: { name: string; platform: string } | null;
  /** For 'local': Bots use the PC's full desktop and a shell, not a private browser. */
  desktop?: boolean;
}

export interface Toolkit {
  slug: string; name: string; logo?: string; description?: string; categories: string[];
  managedAuth: boolean; noAuth: boolean; connected: boolean;
  accounts?: Array<{ id: string; status: string; isDisabled?: boolean } & Partial<ConnectionDetails>>;
}

/** Server-sent events on GET /api/events */
export type ServerEvent = (
  | { type: 'native'; cursor: number }
  | { type: 'hello'; serverTime: number }
  | { type: 'rows'; botId: string; generation: number; rows: Row[] }
  | { type: 'cleared'; botId: string; generation: number }
  | { type: 'live'; state: LiveState }
  | { type: 'roster' }
  | { type: 'bot'; bot: Bot }
  | { type: 'computer'; state: ComputerState }
  | { type: 'routines'; botId: string }
  | { type: 'tasks'; botId: string }
  | { type: 'memories'; botId: string }
  | { type: 'setup'; botId: string }
  | { type: 'connections' }
  | { type: 'messaging' }
  /** Daily synopsis or check-in schedule changed (for example the account time zone moved). */
  | { type: 'synopses'; timezone?: string }
  | { type: 'ping' }) & { runId?: string; runBotId?: string };

/**
 * How hard the model thinks. The OpenRouter levels, plus 'ultracode': the model's highest level,
 * and an instruction to plan and verify. Each model accepts a subset; the
 * server snaps to the nearest one the model supports.
 */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
