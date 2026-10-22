// @vitest-environment jsdom
/**
 * The queue and the turn as the visitor sees them (maquettes Queue, Turn),
 * from the hub's messages, through the reducer and the panel.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewSwitch } from '../Camera';
import { QueuePanel, TurnBadge } from '../HubControls';
import { queueView, type BenchOffer, type QueueAction, type QueueView } from '../hub';
import { setLang } from '../lang';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000; // Unix seconds
const real: BenchOffer = { setup: 'setup-a', kind: 'real', benches: 1, free: 0, waiting: 2, status: 'open' };
const sim: BenchOffer = { setup: 'setup-a', kind: 'sim', benches: 2, free: 1, waiting: 0, status: 'open' };
const soon: BenchOffer = { setup: 'setup-a', kind: 'real', benches: 0, free: 0, waiting: 0, status: 'soon' };

let root: Root;
let box: HTMLDivElement;
const on = { onJoin: vi.fn(), onLeave: vi.fn(), onSeen: vi.fn() };

beforeEach(() => {
  setLang('fr', () => {});
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  Object.values(on).forEach((f) => f.mockClear());
});

afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.useRealTimers();
});

const render = (offers: BenchOffer[], view: QueueView, disabled = false) => act(() => root.render(<QueuePanel offers={offers} view={view} disabled={disabled} {...on} />));
const text = () => box.textContent!.replace(/\s+/g, ' ');
const button = (label: string) => [...box.querySelectorAll('button')].find((b) => b.textContent!.includes(label))!;
const run = (...actions: QueueAction[]) => actions.reduce(queueView, { phase: 'none' } as QueueView);

describe('queue panel', () => {
  it('shows nothing without a bench for the setup', () => {
    render([], { phase: 'none' });
    expect(box.innerHTML).toBe('');
  });

  it('announces a bench coming soon with an inactive button (v0.18)', () => {
    render([soon], { phase: 'none' });
    expect(text()).toContain('Un banc réel arrive bientôt pour ce montage.');
    const b = button('Banc réel · bientôt');
    expect(b.textContent).toBe('Banc réel · bientôt');
    expect(b.disabled).toBe(true);
    act(() => b.click());
    expect(on.onJoin).not.toHaveBeenCalled();
    // Next to an open one: the open one can be joined, the other stays inactive.
    render([sim, soon], { phase: 'none' });
    expect(text()).toContain('Ce montage a aussi des bancs.');
    expect(button('Passer sur le banc simulé').disabled).toBe(false);
    expect(button('bientôt').disabled).toBe(true);
  });

  it('says a queue refused with code soon', () => {
    render([soon], run({ type: 'queue_error', code: 'soon' }));
    expect(text()).toContain('Ce banc arrive bientôt.');
  });

  it('offers one button per kind, with its label', () => {
    render([real, sim, { ...sim, kind: 'sim-esp32' }], { phase: 'none' });
    expect(text()).toContain('Ce montage a aussi des bancs.');
    expect(button('banc réel').textContent).toBe('Passer sur le banc réel2 en file');
    expect(button('banc simulé').textContent).toBe('Passer sur le banc simulé1 libre');
    expect(button('sim-esp32')).toBeTruthy();
    act(() => button('banc réel').click());
    expect(on.onJoin).toHaveBeenCalledWith('real');
  });

  it('cannot join while the live channel is down', () => {
    render([real], { phase: 'none' }, true);
    expect(text()).toContain('Ce montage a aussi un banc réel.');
    expect(button('banc réel').disabled).toBe(true);
  });

  it('shows the place and the estimated wait, and lets it go', () => {
    render([real], run({ type: 'queue', kind: 'real', position: 3, waiting: 4, eta_s: 840 }));
    expect(text()).toContain('Banc réel : vous êtes 3e dans la file, environ 14 min.');
    act(() => button('Quitter la file').click());
    expect(on.onLeave).toHaveBeenCalled();

    render([real], run({ type: 'queue', kind: 'real', position: 1, waiting: 1, eta_s: 0 }));
    expect(text()).toContain('vous êtes 1er dans la file, un banc se libère.');
  });

  it('says it is your turn, counts down, and gives the turn back', () => {
    const view = run({ type: 'queue', kind: 'real', position: 1, waiting: 1, eta_s: 300 }, { type: 'turn', kind: 'real', bench: 'setup-a-1', ends_at: NOW + 272 });
    render([real], view);
    const dialog = box.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('C’est votre tour sur le banc réel.');
    expect(dialog.textContent).toContain('Banc setup-a-1 libéré');
    expect(dialog.textContent).toContain('4:32');
    expect(document.activeElement).toBe(button('Continuer'));
    act(() => vi.advanceTimersByTime(2000));
    expect(dialog.textContent).toContain('4:30');
    expect(text()).toContain('Votre tour sur le banc réel · 4:30 restantes');

    act(() => button('Laisser ma place').click());
    expect(on.onLeave).toHaveBeenCalledTimes(1);
    act(() => button('Continuer').click());
    expect(on.onSeen).toHaveBeenCalled();

    render([real], queueView(view, { type: 'seen' }));
    expect(box.querySelector('[role="dialog"]')).toBeNull();
    expect(button('Rendre mon tour')).toBeTruthy();
  });

  it('says the simulation stays in the browser on a simulated bench', () => {
    render([sim], run({ type: 'turn', kind: 'sim', ends_at: NOW + 60 }));
    expect(box.querySelector('[role="dialog"]')!.textContent).toContain('la simulation reste celle de ce navigateur');
    expect(text()).toContain('Votre tour sur le banc simulé · 1:00 restantes');
    expect(text()).toContain('La simulation reste celle de ce navigateur.');
  });

  it('goes back to the offer on turn_end, for a place or a turn, and says why', () => {
    const turn: QueueAction = { type: 'turn', kind: 'real', ends_at: NOW + 60 };
    const place: QueueAction = { type: 'queue', kind: 'real', position: 2, waiting: 2, eta_s: 300 };
    expect(run(turn, { type: 'turn_end', reason: 'time' })).toEqual({ phase: 'none', note: 'Tour terminé : le temps est écoulé.' });
    expect(run(turn, { type: 'turn_end', reason: 'left' }).note).toBe('Tour rendu : le banc passe au suivant.');
    expect(run(place, { type: 'turn_end', reason: 'left' })).toEqual({ phase: 'none', note: 'Place rendue.' });
    expect(run(place, { type: 'turn_end', reason: 'owner' }).note).toBe('Place perdue : cette page est restée déconnectée plus de 60 secondes.');
    expect(run(turn, { type: 'turn_end', reason: 'bench' }).note).toBe('Tour terminé : le banc s’est déconnecté ou signale une panne.');
    expect(run(place, { type: 'turn_end', reason: 'ended' }).note).toBe('Place perdue : la session est finie.');
    expect(run(turn, { type: 'turn_end', reason: '?' }).note).toBe('Tour terminé.');
  });

  it('starts over on a new connection; the hub resends the place or turn in progress', () => {
    const place: QueueAction = { type: 'queue', kind: 'real', position: 2, waiting: 2, eta_s: 300 };
    expect(run(place, { type: 'reset' })).toEqual({ phase: 'none' });
    // A free bench: the place, then the turn at once.
    expect(run({ type: 'reset' }, { ...place, position: 1, eta_s: 0 }, { type: 'turn', kind: 'real', bench: 'b1', ends_at: NOW + 300 })).toMatchObject({ phase: 'turn', seen: false });
  });

  it('says a refusal of the hub by its code, never by its text', () => {
    const refused = run({ type: 'queue_error', code: 'already_queued' });
    render([real], refused);
    expect(box.querySelector('[role="status"]')!.textContent).toBe('Vous êtes déjà dans la file.');
    expect(button('banc réel')).toBeTruthy();
    const note = (code: string) => run({ type: 'queue_error', code }).note;
    expect(note('full')).toBe('La file est pleine pour le moment : réessayez un peu plus tard.');
    expect(note('unknown_kind')).toBe('Ce type de banc n’est pas proposé pour ce montage.');
    expect(note('nope')).toBe('Le hub a refusé la demande.');
    expect(note('')).toBe('Le hub a refusé la demande.');
    expect(note('constructor')).toBe('Le hub a refusé la demande.');
    setLang('en', () => {});
    expect(note('full')).toBe('The queue is full right now: try again a little later.');
    expect(note('already_queued')).toBe('You are already in the queue.');
    expect(note('unknown_kind')).toBe('This kind of bench is not offered for this setup.');
    expect(note('nope')).toBe('The hub refused the request.');
  });
});

describe('turn seen by a spectator', () => {
  it('shows the kind and the time left', () => {
    act(() => root.render(<TurnBadge turn={{ kind: 'real', ends_at: NOW + 125 }} />));
    expect(text()).toBe('Tour sur le banc réel · 2:05');
    act(() => vi.advanceTimersByTime(1000));
    expect(text()).toBe('Tour sur le banc réel · 2:04');
  });
});

describe('camera during a turn', () => {
  const choices = (scene: boolean, camera: boolean) => {
    act(() => root.render(<ViewSwitch scene={scene} camera={camera} view={camera ? 'camera' : scene ? 'decor' : 'schema'} onChange={on.onJoin} />));
    return [...box.querySelectorAll('label')].map((l) => `${l.textContent}${l.querySelector('input')!.checked ? '*' : ''}`);
  };

  it('offers « Caméra » in place of the scene, selected, only when the turn has a camera', () => {
    expect(choices(true, false)).toEqual(['Décor*', 'Schéma']);
    expect(choices(true, true)).toEqual(['Caméra*', 'Schéma']);
    expect(choices(false, true)).toEqual(['Caméra*', 'Schéma']);
    expect(choices(false, false)).toEqual(['Schéma*']);
  });
});
