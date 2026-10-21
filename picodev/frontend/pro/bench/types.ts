/**
 * Types shared by the bench workspace.
 *
 * The sheet types mirror the JSON Schema of the setup sheets (kept with the
 * setups, outside this repository), which is the exact form of the format: read a sheet, never extend it on this side only.
 */

// ── Setup sheet (served under [bench].setups_url) ───────────────────────────

export interface SetupIndex {
  schema: 1;
  setups: SetupIndexEntry[];
}

export interface SetupIndexEntry {
  id: string;
  title: string;
  summary: string;
  status: 'available' | 'soon';
  modes: Array<'free' | 'challenge'>;
}

export interface SetupSheet {
  schema: 1;
  id: string;
  title: string;
  summary: string;
  /** `kind` is the Velxio board kind, `fqbn` what the server compiles for. */
  board: { kind: string; fqbn: string };
  /** The first file is the main sketch. */
  files: Array<{ name: string; content: string }>;
  /** "Name@version", a subset of the deployed toolchain. */
  libraries: string[];
  /** Velxio's own example shape (components and wires). */
  circuit: { components: unknown[]; wires: unknown[] };
  probes: Array<{ pin: number; label: string; kind: 'scope' | 'logic' }>;
  /** What the assembly does mechanically, which the simulation must imitate. */
  couplings?: Coupling[];
  scene?: { svg: string; bindings: SceneBinding[] };
  /** Empty when the setup has no challenge. */
  levels: Level[];
  /** Translations by language; anything missing shows the French text. */
  i18n?: Record<string, SheetTranslation>;
}

export interface SheetTranslation {
  title?: string;
  summary?: string;
  levels?: Record<string, { title?: string; brief?: string; hints?: string[] }>;
  /** Test label by test id. */
  tests?: Record<string, string>;
  /** The starting sketch, translated: same file names as `files`. */
  files?: Array<{ name: string; content: string }>;
}

/** The languages of the bench pages. */
export type Lang = 'fr' | 'en';

/** A signal source: `pin:<n>` (0|1), `pwm:<n>` (0..1), `servo:<n>` (degrees). */
export type Source = `pin:${number}` | `pwm:${number}` | `servo:${number}`;

/** While `source` is within [min, max], `pin` is held at `level`; else at the opposite. */
export interface Coupling {
  source: Source;
  min?: number;
  max?: number;
  pin: number;
  level: 'high' | 'low';
}

export type SceneBinding =
  | { target: string; source: Source; effect: 'visible'; when: 'high' | 'low' }
  | { target: string; source: Source; effect: 'fill'; on: string; off: string }
  /** Maps the source range [min, max] to an angle [from, to], around `origin`. */
  | { target: string; source: Source; effect: 'rotate'; min: number; max: number; from: number; to: number; origin?: [number, number] }
  /** Maps [min, max] to an offset from (0, 0) to (dx, dy). */
  | { target: string; source: Source; effect: 'translate'; min: number; max: number; dx: number; dy: number }
  /** Turns continuously while the source is above `threshold`. */
  | { target: string; source: Source; effect: 'spin'; threshold: number; origin?: [number, number] };

export interface Level {
  id: string;
  title: string;
  brief: string;
  hints: string[];
  /** How long the tests observe, in simulated milliseconds. */
  timeout_ms: number;
  /** Inputs forced during the observation, on top of the couplings. */
  stimulus?: Array<{ at_ms: number; pin: number; level: 'high' | 'low' }>;
  tests: Array<{ id: string; label: string; spec: TestSpec }>;
}

/** Declarative: a test never contains code. Times are simulated time. */
export type TestSpec =
  /** `pin` is at `level` at `at_ms`. */
  | { type: 'pin_level'; pin: number; level: 'high' | 'low'; at_ms: number }
  /** Every edge of `source` is followed by the same edge of `pin` (the opposite one with `invert`) within `max_delay_ms`; at least `min_edges` edges seen (default 2). */
  | { type: 'follows'; pin: number; source: number; max_delay_ms: number; invert?: boolean; min_edges?: number }
  /** At least `count` (default 1) pulses at `level` lasting between `min_ms` and `max_ms`. */
  | { type: 'pulse'; pin: number; level: 'high' | 'low'; min_ms: number; max_ms: number; count?: number }
  /** The serial output contains `text` before `within_ms`. */
  | { type: 'serial_contains'; text: string; within_ms: number };

// ── What the engines see of the simulation ──────────────────────────────────

/**
 * The running bench, as the scene player and the test runner use it. The
 * workspace implements it over Velxio's simulator; a real bench could
 * implement it over a logic analyser. Every callback returns its unsubscribe.
 */
export interface BenchProbe {
  /** Simulated time since the last reset, in milliseconds. */
  nowMs(): number;
  onPin(pin: number, cb: (high: boolean, tMs: number) => void): () => void;
  onPwm(pin: number, cb: (duty: number, tMs: number) => void): () => void;
  onServo(pin: number, cb: (angleDeg: number, tMs: number) => void): () => void;
  onSerial(cb: (text: string, tMs: number) => void): () => void;
  /** Forces an input pin, now or at a simulated time. */
  setPin(pin: number, high: boolean, atMs?: number): void;
}

export type TestStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface TestResult {
  id: string;
  status: TestStatus;
  /** One short sentence for the visitor: what was measured. */
  detail?: string;
}

// Implemented in ./engine (pure, no Velxio import):
//   mountScene(container, svgText, bindings, probe): () => void
//   applyCouplings(couplings, probe): () => void
//   runLevel(level, probe, onUpdate: (results: TestResult[]) => void, lang?): { done: Promise<TestResult[]>; cancel(): void }

/**
 * One observation of the bench, as the hub relays it (`events` of the live
 * channel): `v` is 0|1 for `pin`, the duty 0..1 for `pwm`, degrees for
 * `servo`, text for `serial`. `t` is the simulated time of the owner.
 */
export interface BenchEvent {
  t: number;
  k: 'pin' | 'pwm' | 'servo' | 'serial';
  pin?: number;
  v: number | string;
}
