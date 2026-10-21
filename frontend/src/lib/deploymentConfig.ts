/**
 * Deployment-level configuration.
 *
 * Lets a self-hosted instance present itself under its own name and restrict
 * the boards it offers without patching components. Each value is read, in
 * order, from:
 *
 *   1. `window.__LAB_CONFIG__`, set at run time by a `/config.js` that the
 *      server renders from its deployment file (one image, any deployment);
 *   2. the build-time variable;
 *   3. the stock Velxio behaviour.
 *
 *   brandName     / VITE_BRAND_NAME     product name shown in the header (default "Velxio")
 *   allowedBoards / VITE_ALLOWED_BOARDS board kinds offered in the pickers (default: every board)
 *   defaultBoard  / VITE_DEFAULT_BOARD  board kind of the initial workspace (default "arduino-uno")
 *   sourceUrl     / VITE_SOURCE_URL     where the source of this instance is published
 */
import type { BoardKind } from '../types/board';

interface RuntimeConfig {
  brandName?: string;
  allowedBoards?: string[];
  defaultBoard?: string;
  sourceUrl?: string;
}

const runtime: RuntimeConfig =
  (globalThis as { __LAB_CONFIG__?: RuntimeConfig }).__LAB_CONFIG__ ?? {};
const env = import.meta.env as Record<string, string | undefined>;

export const BRAND_NAME: string =
  (runtime.brandName || env.VITE_BRAND_NAME || '').trim() || 'Velxio';

const allowed =
  runtime.allowedBoards ??
  (env.VITE_ALLOWED_BOARDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const ALLOWED_BOARDS: ReadonlySet<string> | null = allowed.length ? new Set(allowed) : null;

/** True when the deployment offers this board kind (always true without a list). */
export function isBoardAllowed(kind: BoardKind | string): boolean {
  return ALLOWED_BOARDS === null || ALLOWED_BOARDS.has(kind);
}

export const DEFAULT_BOARD: BoardKind = ((runtime.defaultBoard || env.VITE_DEFAULT_BOARD || '').trim() ||
  'arduino-uno') as BoardKind;

/** Empty when the deployment does not publish its own source link. */
export const SOURCE_URL: string = (runtime.sourceUrl || env.VITE_SOURCE_URL || '').trim();
