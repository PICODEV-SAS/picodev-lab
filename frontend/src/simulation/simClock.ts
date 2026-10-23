/**
 * Visibility-proof animation clock for the simulation loop.
 * =========================================================
 *
 * The sim steps the CPU on requestAnimationFrame, but browsers freeze rAF while a
 * tab is backgrounded — so the whole simulation pauses whenever its tab isn't the
 * foreground one. That breaks the agent-driven / hardware-in-the-loop flow, where
 * the human watches another window while an agent drives the sim over MCP.
 *
 * This drives the loop from a Web Worker's timer instead. Worker timers are NOT
 * throttled by page visibility, so the CPU keeps running at full rate when hidden.
 * Canvas rendering still uses rAF (fine to throttle — nobody's looking).
 *
 * Same one-shot semantics as requestAnimationFrame: the callback re-registers to
 * continue. Falls back to rAF / setTimeout when there is no Worker (SSR, tests).
 */

type FrameCb = (timestamp: number) => void;

let nextId = 1;
const pending = new Map<number, FrameCb>();
let worker: Worker | null = null;
let triedWorker = false;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function flush(): void {
  if (pending.size === 0) return;
  const t = now();
  const cbs = Array.from(pending.values());
  pending.clear(); // one-shot: callbacks re-register via requestSimFrame to continue
  for (const cb of cbs) {
    try {
      cb(t);
    } catch (err) {
      console.error('[simClock] frame callback threw:', err);
    }
  }
}

function ensureWorker(): void {
  if (triedWorker) return;
  triedWorker = true;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return;
    // ~10 ms (100 Hz) heartbeat; the execute loop paces itself from the real
    // elapsed time, so the exact rate only needs to be fine enough.
    const src = 'let h=setInterval(function(){postMessage(0);},10);';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    worker = new Worker(url);
    worker.onmessage = flush;
  } catch {
    worker = null; // fall back to rAF below
  }
}

/** Like requestAnimationFrame, but keeps firing when the tab is backgrounded. */
export function requestSimFrame(cb: FrameCb): number {
  const id = nextId++;
  pending.set(id, cb);
  ensureWorker();
  if (!worker) {
    // Fallback: rAF when available (throttled when hidden, but better than nothing),
    // else a timer.
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => flush());
    else setTimeout(flush, 16);
  }
  return id;
}

export function cancelSimFrame(id: number | null | undefined): void {
  if (id != null) pending.delete(id);
}
