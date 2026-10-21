// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountScene } from '../scene';
import { fakeProbe } from './fakeProbe';

const svg = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

let container: HTMLElement;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mountScene: sanitiser', () => {
  it('removes scripts, foreignObject and foreign elements', () => {
    mountScene(
      container,
      svg(`
        <script>window.pwned = 1</script>
        <g><SCRIPT>window.pwned = 1</SCRIPT></g>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
        <h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/>
        <h:script xmlns:h="http://www.w3.org/1999/xhtml">window.pwned = 1</h:script>
        <rect id="ok" width="1" height="1"/>`),
      [],
      f().probe,
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('#ok')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/script|foreignObject|iframe|div|pwned/i);
  });

  it('removes every on* attribute, on the root too', () => {
    mountScene(
      container,
      svg(
        '<rect id="r" onclick="alert(1)" onMouseOver="alert(2)" width="1"/>',
        'onload="alert(0)"',
      ),
      [],
      f().probe,
    );
    expect(container.innerHTML).not.toMatch(/alert|onload|onclick|onmouseover/i);
    expect(container.querySelector('#r')!.getAttribute('width')).toBe('1');
  });

  it('keeps only #fragment links', () => {
    mountScene(
      container,
      svg(`
        <defs><circle id="dot" r="1"/></defs>
        <use id="local" href="#dot"/>
        <use id="oldlocal" xlink:href="#dot"/>
        <use id="ext" href="https://evil.example/x.svg#a"/>
        <use id="oldext" xlink:href="//evil.example/x.svg#a"/>
        <a id="js" href=" javascript:alert(1)"><text>x</text></a>
        <image id="img" href="data:image/svg+xml,&lt;svg/&gt;"/>`),
      [],
      f().probe,
    );
    const href = (id: string) => {
      const el = container.querySelector(`#${id}`)!;
      return el.getAttribute('href') ?? el.getAttribute('xlink:href');
    };
    expect(href('local')).toBe('#dot');
    expect(href('oldlocal')).toBe('#dot');
    for (const id of ['ext', 'oldext', 'js', 'img']) expect(href(id)).toBeNull();
    expect(container.innerHTML).not.toMatch(/evil|javascript|data:/);
  });

  it('removes animations that write a link or a handler', () => {
    mountScene(
      container,
      svg(`
        <a id="a"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="javascript:alert(1)"/></a>
        <rect id="r"><animate id="fine" attributeName="opacity" values="0;1" dur="1s"/></rect>`),
      [],
      f().probe,
    );
    expect(container.innerHTML).not.toMatch(/javascript/);
    expect(container.querySelector('#fine')).not.toBeNull();
  });

  it('shows nothing when the text is not an SVG', () => {
    container.innerHTML = '<p>old</p>';
    const cleanup = mountScene(
      container,
      '<html xmlns="http://www.w3.org/1999/xhtml"><script>1</script></html>',
      [],
      f().probe,
    );
    expect(container.childNodes).toHaveLength(0);
    mountScene(container, 'not xml <', [], f().probe);
    expect(container.querySelector('script')).toBeNull();
    expect(warn).toHaveBeenCalled();
    cleanup();
  });
});

describe('mountScene: bindings', () => {
  it('shows and hides with visible', () => {
    const p = f();
    mountScene(
      container,
      svg('<rect id="on"/><rect id="off"/>'),
      [
        { target: 'on', source: 'pin:13', effect: 'visible', when: 'high' },
        { target: 'off', source: 'pin:13', effect: 'visible', when: 'low' },
      ],
      p.probe,
    );
    const shown = (id: string) =>
      (container.querySelector(`#${id}`) as SVGElement).style.display !== 'none';
    expect([shown('on'), shown('off')]).toEqual([false, true]); // source starts at 0
    p.pin(13, true, 1);
    expect([shown('on'), shown('off')]).toEqual([true, false]);
    p.pin(13, false, 2);
    expect([shown('on'), shown('off')]).toEqual([false, true]);
  });

  it('colours with fill', () => {
    const p = f();
    mountScene(
      container,
      svg('<circle id="led"/>'),
      [
        {
          target: 'led',
          source: 'pwm:6',
          effect: 'fill',
          on: 'red',
          off: 'gray',
        },
      ],
      p.probe,
    );
    const led = container.querySelector('#led') as SVGElement;
    expect(led.style.getPropertyValue('fill')).toBe('gray');
    p.pwm(6, 0.3);
    expect(led.style.getPropertyValue('fill')).toBe('red');
    p.pwm(6, 0);
    expect(led.style.getPropertyValue('fill')).toBe('gray');
  });

  it('rotates in proportion, clamped, after the transform already there', () => {
    const p = f();
    mountScene(
      container,
      svg('<g id="arm" transform="translate(5 5)"/>'),
      [
        {
          target: 'arm',
          source: 'servo:9',
          effect: 'rotate',
          min: 0,
          max: 180,
          from: -90,
          to: 90,
          origin: [10, 20],
        },
      ],
      p.probe,
    );
    const t = () => container.querySelector('#arm')!.getAttribute('transform');
    expect(t()).toBe('translate(5 5) rotate(-90 10 20)');
    p.servo(9, 90);
    expect(t()).toBe('translate(5 5) rotate(0 10 20)');
    p.servo(9, 400);
    expect(t()).toBe('translate(5 5) rotate(90 10 20)');
  });

  it('translates in proportion', () => {
    const p = f();
    mountScene(
      container,
      svg('<g id="door"/>'),
      [
        {
          target: 'door',
          source: 'servo:9',
          effect: 'translate',
          min: 0,
          max: 100,
          dx: 40,
          dy: -10,
        },
      ],
      p.probe,
    );
    p.servo(9, 50);
    expect(container.querySelector('#door')!.getAttribute('transform')).toBe('translate(20 -5)');
  });

  it('spins with animation frames only while above the threshold', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const raf = vi.fn((cb: FrameRequestCallback) => (frames.set(++id, cb), id));
    const caf = vi.fn((n: number) => void frames.delete(n));
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    const frame = (ts: number) => {
      const [[n, cb]] = [...frames];
      frames.delete(n);
      cb(ts);
    };

    const p = f();
    const cleanup = mountScene(
      container,
      svg('<g id="fan"/>'),
      [
        {
          target: 'fan',
          source: 'pwm:5',
          effect: 'spin',
          threshold: 0.1,
          origin: [3, 4],
        },
      ],
      p.probe,
    );
    const t = () => container.querySelector('#fan')?.getAttribute('transform');
    expect(raf).not.toHaveBeenCalled();
    p.pwm(5, 0.05);
    expect(raf).not.toHaveBeenCalled();

    p.pwm(5, 0.5);
    p.pwm(5, 0.6); // already spinning: no second loop
    expect(frames.size).toBe(1);
    frame(1000);
    frame(1250); // a quarter of a second at one turn a second
    expect(t()).toBe('rotate(90 3 4)');

    p.pwm(5, 0);
    expect(frames.size).toBe(0);
    expect(t()).toBe('rotate(90 3 4)'); // stops where it is

    p.pwm(5, 1);
    expect(frames.size).toBe(1);
    cleanup();
    expect(frames.size).toBe(0);
  });

  it('warns once for an unknown target and applies the others', () => {
    const p = f();
    mountScene(
      container,
      svg('<rect id="here"/>'),
      [
        { target: 'gone', source: 'pin:1', effect: 'visible', when: 'high' },
        {
          target: 'gone',
          source: 'pin:1',
          effect: 'fill',
          on: 'red',
          off: 'gray',
        },
        { target: 'here', source: 'pin:1', effect: 'visible', when: 'low' },
      ],
      p.probe,
    );
    expect(warn).toHaveBeenCalledOnce();
    p.pin(1, true, 1);
    expect((container.querySelector('#here') as SVGElement).style.display).toBe('none');
  });

  it('unsubscribes and empties the container on cleanup', () => {
    const p = f();
    const cleanup = mountScene(
      container,
      svg('<rect id="a"/>'),
      [{ target: 'a', source: 'pin:1', effect: 'visible', when: 'high' }],
      p.probe,
    );
    expect(p.listenerCount()).toBe(1);
    cleanup();
    expect(p.listenerCount()).toBe(0);
    expect(container.childNodes).toHaveLength(0);
  });
});

function f() {
  return fakeProbe();
}
