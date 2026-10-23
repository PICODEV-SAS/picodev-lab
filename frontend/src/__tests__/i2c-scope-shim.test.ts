/**
 * I2C scope shim — proves the synthesized SDA/SCL waveform decodes back to the
 * original transaction, i.e. a logic analyzer (and the AI agent) can recover the
 * I2C from the capture. This is the L1 "sniff the bus" capability, validated.
 */
import { describe, it, expect } from 'vitest';
import { I2cScopeShim, I2C_SDA_PIN, I2C_SCL_PIN } from '../simulation/I2cScopeShim';

type Edge = { t: number; pin: number; v: 0 | 1 };

// A minimal I2C decoder working off pin edges, as a logic analyzer would.
function decodeI2C(edges: Edge[]): Array<{ addr: number; rw: 'W' | 'R'; data: number[] }> {
  edges = [...edges].sort((a, b) => a.t - b.t);
  let sda = 1, scl = 1;
  const frames: Array<{ addr: number; rw: 'W' | 'R'; data: number[] }> = [];
  let inFrame = false, bitCount = 0, cur = 0, first = true;
  let frame: { addr: number; rw: 'W' | 'R'; data: number[] } | null = null;

  for (const e of edges) {
    const prevScl = scl, prevSda = sda;
    if (e.pin === I2C_SDA_PIN) sda = e.v; else scl = e.v;

    // START (or repeated START): SDA 1→0 while SCL high.
    if (scl === 1 && prevSda === 1 && sda === 0 && prevScl === 1) {
      if (frame) frames.push(frame); // a repeated START ends the prior phase
      inFrame = true; bitCount = 0; cur = 0; first = true;
      frame = { addr: 0, rw: 'W', data: [] };
      continue;
    }
    // STOP: SDA 0→1 while SCL high.
    if (scl === 1 && prevSda === 0 && sda === 1 && prevScl === 1) {
      if (frame) frames.push(frame);
      inFrame = false; frame = null;
      continue;
    }
    // Sample a bit on SCL rising edge.
    if (inFrame && prevScl === 0 && scl === 1) {
      if (bitCount < 8) {
        cur = (cur << 1) | sda; // MSB first
        bitCount++;
      } else {
        // 9th clock = ACK (ignored for decoding the byte value).
        if (first) {
          frame!.addr = cur >> 1;
          frame!.rw = (cur & 1) ? 'R' : 'W';
          first = false;
        } else {
          frame!.data.push(cur);
        }
        bitCount = 0; cur = 0;
      }
    }
  }
  return frames;
}

function runTxn(events: Parameters<I2cScopeShim['onEvent']>[0][]): Edge[] {
  const edges: Edge[] = [];
  let cyc = 1000;
  const shim = new I2cScopeShim(
    (pin, state, timeMs) => edges.push({ t: timeMs, pin, v: state ? 1 : 0 }),
    () => cyc,
  );
  for (const ev of events) shim.onEvent(ev);
  return edges;
}

describe('I2C scope shim — waveform decodes back to the transaction', () => {
  it('a register write (addr 0x20, [0x01, 0xA5]) is recoverable', () => {
    const edges = runTxn([
      { kind: 'start' },
      { kind: 'addr', addr: 0x20, write: true, ack: true },
      { kind: 'write', value: 0x01, ack: true },
      { kind: 'write', value: 0xa5, ack: true },
      { kind: 'stop' },
    ]);
    expect(edges.length).toBeGreaterThan(10);
    const frames = decodeI2C(edges);
    expect(frames).toHaveLength(1);
    expect(frames[0].addr).toBe(0x20);
    expect(frames[0].rw).toBe('W');
    expect(frames[0].data).toEqual([0x01, 0xa5]);
  });

  it('a register read (pointer write + read of DEVID bytes) is recoverable', () => {
    // Pointer set (write 0x02), repeated START, read "LC" (0x4C, 0x43).
    const edges = runTxn([
      { kind: 'start' },
      { kind: 'addr', addr: 0x20, write: true, ack: true },
      { kind: 'write', value: 0x02, ack: true },
      { kind: 'start' }, // repeated START
      { kind: 'addr', addr: 0x20, write: false, ack: true },
      { kind: 'read', value: 0x4c, ack: true },
      { kind: 'read', value: 0x43, ack: false }, // last byte NACK
      { kind: 'stop' },
    ]);
    const frames = decodeI2C(edges);
    // Two framed bursts: the pointer write and the read.
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ addr: 0x20, rw: 'W', data: [0x02] });
    expect(frames[1]).toMatchObject({ addr: 0x20, rw: 'R', data: [0x4c, 0x43] });
  });
});
