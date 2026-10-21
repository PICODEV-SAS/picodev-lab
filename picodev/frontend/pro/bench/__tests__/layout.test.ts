import { describe, expect, it } from 'vitest';
import { COLUMNS, MIN_SIZE, moveTo, PARTS, readLayout, step } from '../layout';

describe('layout', () => {
  it('reads a stored layout back', () => {
    const l = { columns: ['hub', 'code', 'level', 'agent'], parts: ['serial', 'view', 'traces', 'capture'], size: { code: 500, view: 300 }, folded: ['level', 'serial'] };
    expect(readLayout(JSON.stringify(l))).toEqual(l);
  });

  it('falls back to the default on garbage', () => {
    const def = { columns: [...COLUMNS], parts: [...PARTS], size: {}, folded: [] };
    for (const raw of [null, '', 'nope', '42', '{"columns":["code","code","hub","level"]}', '{"parts":["view"]}', '{"columns":["x","y","z","w"]}'])
      expect(readLayout(raw)).toEqual(def);
  });

  it('keeps only the sizes it can use', () => {
    const raw = JSON.stringify({ size: { code: 300.6, hub: MIN_SIZE - 1, view: 'big', serial: 1e9, nope: 300 } });
    expect(readLayout(raw).size).toEqual({ code: 301 });
  });

  it('keeps only known sections as folded, each once', () => {
    expect(readLayout(JSON.stringify({ folded: ['serial', 'nope', 'code', 'serial', 3] })).folded).toEqual(['code', 'serial']);
    expect(readLayout(JSON.stringify({ folded: 'code' })).folded).toEqual([]);
    expect(readLayout(JSON.stringify({ columns: ['hub', 'code', 'level', 'agent'] })).folded).toEqual([]); // a record from before folding
  });

  it('moves a section to the place of another', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveTo(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(moveTo(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });

  it('steps over the sections not shown', () => {
    const order = ['agent', 'level', 'code', 'hub'];
    expect(step(order, 'code', -1, ['code', 'hub'])).toEqual(order);
    expect(step(order, 'code', 1, ['code', 'hub'])).toEqual(['agent', 'level', 'hub', 'code']);
    expect(step(order, 'hub', -1, ['agent', 'code', 'hub'])).toEqual(['agent', 'level', 'hub', 'code']);
    expect(step(order, 'agent', -1, order)).toEqual(order);
  });
});
