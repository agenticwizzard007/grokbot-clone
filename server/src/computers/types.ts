import type { WebSocket } from 'ws';
import type { ComputerState, LibraryFile } from '../types.js';

/**
 * A computer provider supplies Bots' computers. The rest of the server only talks to
 * the active provider (see ./index.ts), so new kinds of computers plug in here.
 */

/** A screenshot: base64 image data (no data: prefix). */
export interface Shot { image: string; mime: string; width: number; height: number }

/** One Bot's screen: everything the agent's computer tools need. */
export interface BotScreen {
  screenshot(): Promise<Shot>;
  click(a: { x: number; y: number; button?: string; double?: boolean }): Promise<void>;
  drag(a: { start_x: number; start_y: number; end_x: number; end_y: number }): Promise<void>;
  type(text: string): Promise<void>;
  /** X11 keysym names joined by "+". May return a note for the model (e.g. a shortcut that isn't available). */
  key(keys: string): Promise<string | void>;
  scroll(a: { x: number; y: number; direction: 'up' | 'down'; amount: number }): Promise<void>;
  /** Open a URL in the Bot's browser. */
  openUrl(url: string): Promise<void>;
  /** Present only when the provider has a shell (capabilities.shell). */
  shell?(command: string, timeoutSec: number): Promise<{ exit_code: number; output: string }>;
  /** Present only with Playwright browser tools (capabilities.browser): run one on the Bot's own Chrome. */
  browser?(tool: string, args: Record<string, unknown>): Promise<BrowserResult>;
}

/** An MCP tool result from Playwright: text (snapshots, logs) and images (screenshots). */
export interface BrowserResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError: boolean;
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string }

/** An error with an HTTP status and a message that is safe to show the user. */
export class ComputerError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export interface ComputerProvider {
  kind: 'orgo' | 'local' | 'cloudvm';
  /** shell: a command line; browser: Playwright browser tools on the Bot's Chrome (see browser-tools.ts). */
  capabilities: { shell: boolean; browser?: boolean };
  /** System-prompt line describing the Bot's computer. */
  promptLine: string;
  /** A user-specific prompt line (e.g. naming the connected PC's operating system); falls back to promptLine. */
  promptFor?(userId: string): string;
  /** Provider-specific tool descriptions, by tool name. */
  toolDescriptions?: Partial<Record<string, string>>;

  state(userId: string): ComputerState;
  /** Re-check the computer's real status (cheap; used when the UI opens). */
  refresh(userId: string): Promise<ComputerState>;
  /** Make the computer usable (wake it, or check the PC is connected). Throws ComputerError if it can't. */
  ensure(userId: string): Promise<void>;
  suspend(userId: string): Promise<void>;

  /** The Bot's screen, waking the computer and leasing a screen if needed. */
  screen(userId: string, botId: string): Promise<BotScreen>;
  /** A current picture of the Bot's screen without waking anything; null if it has none. */
  peek(userId: string, botId: string): Promise<Shot | null>;
  /** Close everything on the Bot's screen so it starts clean. */
  resetScreen(userId: string, botId: string): Promise<{ ok: true; note?: string; screenId?: string }>;
  screens(userId: string): { botId: string; screenId: string; lastUsedAt: number }[];

  files: {
    /** Save a Library file for the Bot; returns the path to report to the model. */
    save(userId: string, botId: string, name: string, content: string): Promise<string>;
    list(userId: string, botId: string, rel: string, wake: boolean): Promise<LibraryListing>;
    /** A URL the browser can download the file from. */
    download(userId: string, botId: string, rel: string): Promise<string>;
  };

  /** Serve the live viewer: an RFB (VNC) session over the browser's WebSocket, shown with noVNC. */
  viewer(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control'): Promise<void>;

  /** Start background jobs (e.g. idle hibernation). */
  start?(): void;
}
