/**
 * I2C scope shim — makes hardware-TWI traffic visible to the logic analyzer.
 * ========================================================================
 *
 * avr8js's TWI is purely transactional: a `Wire` transaction never toggles the
 * SDA/SCL pins, so a logic capture on them is empty. This shim synthesizes the
 * bit-level SDA/SCL waveform from the transaction the bus already observes and
 * emits it via onPinChangeWithTime — exactly analogous to `emitUartTxFrame` for
 * UART. The player keeps identical `Wire` code in sim and on the real bench (where
 * a physical analyzer sees the real lines); this only fills the sim's gap.
 *
 * Standalone and engine-free so it can be unit-tested by decoding its output back.
 */

export type I2cBusEvent =
  | { kind: 'start' }
  | { kind: 'addr'; addr: number; write: boolean; ack: boolean }
  | { kind: 'write'; value: number; ack: boolean }
  | { kind: 'read'; value: number; ack: boolean }
  | { kind: 'stop' };

export const I2C_SDA_PIN = 18; // A4 on Uno/Nano (PC4)
export const I2C_SCL_PIN = 19; // A5 on Uno/Nano (PC5)

export class I2cScopeShim {
  // One transaction buffered as ops: bytes and repeated-START markers, rendered
  // as a single continuous waveform on STOP.
  private ops: Array<{ rs: true } | { byte: number; ack: boolean }> = [];
  private startCycle = 0;
  private pending = false;

  constructor(
    private readonly emit: (pin: number, state: boolean, timeMs: number) => void,
    private readonly cyclesNow: () => number,
    private readonly opts: {
      sdaPin?: number; sclPin?: number; freqHz?: number; sclHz?: number;
    } = {},
  ) {}

  onEvent(ev: I2cBusEvent): void {
    switch (ev.kind) {
      case 'start':
        if (!this.pending) {
          this.startCycle = this.cyclesNow();
          this.ops = [];
          this.pending = true;
        } else {
          this.ops.push({ rs: true }); // repeated START within the transaction
        }
        break;
      case 'addr':
        this.ops.push({ byte: ((ev.addr & 0x7f) << 1) | (ev.write ? 0 : 1), ack: ev.ack });
        break;
      case 'write':
        this.ops.push({ byte: ev.value & 0xff, ack: ev.ack });
        break;
      case 'read':
        this.ops.push({ byte: ev.value & 0xff, ack: ev.ack });
        break;
      case 'stop':
        if (this.pending) { this.flush(); this.pending = false; this.ops = []; }
        break;
    }
  }

  private flush(): void {
    if (!this.ops.length) return;
    const freqHz = this.opts.freqHz ?? 16_000_000;
    const sclHz = this.opts.sclHz ?? 100_000;
    const sdaPin = this.opts.sdaPin ?? I2C_SDA_PIN;
    const sclPin = this.opts.sclPin ?? I2C_SCL_PIN;
    const T = freqHz / sclHz;      // cycles per bit
    const h = T / 2, q = T / 4;

    const edges: Array<[number, number, boolean]> = []; // [cycle, pin, state]
    let sda = true, scl = true;    // bus idles high
    let t = this.startCycle;
    const set = (pin: number, val: boolean) => {
      const cur = pin === sdaPin ? sda : scl;
      if (cur === val) return;
      if (pin === sdaPin) sda = val; else scl = val;
      edges.push([t, pin, val]);
    };

    const clockBit = (level: boolean) => {
      set(sdaPin, level); t += q;   // set data while SCL low
      set(sclPin, true);  t += h;   // rising edge = sample point
      set(sclPin, false); t += q;   // fall, prep next bit
    };
    const startCond = () => {       // SDA 1→0 while SCL high, then SCL→0
      set(sdaPin, true); t += q;
      set(sclPin, true); t += q;
      set(sdaPin, false); t += q;
      set(sclPin, false); t += q;
    };

    startCond(); // initial START
    for (const op of this.ops) {
      if ('rs' in op) { startCond(); continue; } // repeated START
      for (let i = 7; i >= 0; i--) clockBit(((op.byte >> i) & 1) === 1);
      clockBit(!op.ack); // 9th clock: ACK = SDA low, NACK = SDA high
    }

    // STOP: ensure SDA low while SCL low, SCL→high, then SDA 0→1 while SCL high.
    set(sdaPin, false); t += q;
    set(sclPin, true);  t += q;
    set(sdaPin, true);  t += q;

    for (const [cyc, pin, val] of edges) this.emit(pin, val, cyc / 16_000);
  }
}
