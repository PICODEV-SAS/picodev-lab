// @vitest-environment jsdom
/** A sheet's waypoints (0.24) through Velxio's loadExample, into the store and the schema's wire path. */
import { describe, expect, it, vi } from 'vitest';
import { useSimulatorStore } from '@velxio/store/useSimulatorStore';
import { loadExample } from '@velxio/utils/loadExample';
import { generateOrthogonalPath } from '@velxio/utils/wireUtils';
import { boardPinToNumber } from '@velxio/utils/boardPinMapping';
import { withWaypoints } from '../circuit';
import { toExample } from '../sheet';
import type { SetupSheet } from '../types';
import { wiresOn, type PlainWire } from '../wiring';

// Its `?url` WASM import is outside what this config's Vite serves; a Pico's MicroPython is not loaded here.
vi.mock('@velxio/simulation/MicroPythonLoader', () => ({}));

const pts = [
  { x: 400, y: 120 },
  { x: 400, y: 260 },
];
const sheet = {
  id: 'wp',
  title: 'wp',
  board: { kind: 'arduino-uno', fqbn: 'arduino:avr:uno' },
  files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n' }],
  circuit: {
    components: [{ type: 'wokwi-led', id: 'led1', x: 500, y: 300, properties: { color: 'red' } }],
    wires: [
      { id: 'w1', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'led1', pinName: 'A' }, color: '#f00', waypoints: pts },
      { id: 'w2', start: { componentId: 'arduino-uno', pinName: 'GND.1' }, end: { componentId: 'led1', pinName: 'C' }, color: '#000', waypoints: [{ x: 1, y: NaN }] },
    ],
  },
  probes: [],
} as unknown as SetupSheet;

describe('sheet waypoints (0.24)', () => {
  it('reach the wires given to Velxio and the path the schema draws', async () => {
    // What the bench and the studio do: loadExample, then the sheet's waypoints back.
    await loadExample(toExample(sheet));
    const sim = useSimulatorStore.getState();
    sim.setWires(withWaypoints(sim.wires, sheet.circuit.wires));
    const { wires, activeBoardId } = useSimulatorStore.getState();
    expect(wires.find((w) => w.id === 'w1')!.waypoints).toEqual(pts);
    expect(wires.find((w) => w.id === 'w2')!.waypoints).toEqual([]); // invalid: Velxio's own route

    // Schema: the wires on a probed pin, drawn as Schema.tsx draws them.
    const on = wiresOn(13, wires as PlainWire[], activeBoardId!, (n) => boardPinToNumber('arduino-uno', n));
    expect(on.map(({ wire }) => wire.id)).toEqual(['w1']);
    const { wire } = on[0];
    const d = generateOrthogonalPath(wire.start, wire.waypoints ?? [], wire.end);
    expect(d).toBe(generateOrthogonalPath(wire.start, pts, wire.end));
    expect(d).not.toBe(generateOrthogonalPath(wire.start, [], wire.end));
  });
});
