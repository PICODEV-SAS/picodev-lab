/**
 * Overlay entry point (frontend).
 *
 * Velxio loads this module at startup when the bundle is built with
 * VITE_PRO_BUILD=true and PRO_OVERLAY_PATH pointing at this directory (see
 * picodev/docker/Dockerfile). The name and the source link shown here come
 * from the deployment file through deploymentConfig; with none, the overlay
 * leaves the stock Velxio presentation alone.
 */
import { createElement, lazy, Suspense } from 'react';
import { BRAND_NAME, SOURCE_URL } from '@velxio/lib/deploymentConfig';
import { registerProRoutes } from '@velxio/lib/proRoutes';
import { ONLINE_ONLY_BOARD_ADS, ONLINE_ONLY_COMPONENT_ADS, suppressOnlineOnlyAds } from '@velxio/lib/onlineOnlyBoards';

const UPSTREAM_URL = 'https://velxio.dev';
const UPSTREAM_SOURCE_URL = 'https://github.com/davidmonterocrespo24/velxio';
const REBRANDED = BRAND_NAME !== 'Velxio';

const STYLE = `
:root {
  --picodev-navy: #0A2440;
  --picodev-coral: #E7746F;
}
.picodev-attribution {
  position: fixed;
  left: 12px;
  bottom: 10px;
  z-index: 50;
  font: 500 11px/1.4 system-ui, sans-serif;
  color: #4A5B70;
  background: rgba(251, 250, 248, 0.92);
  border: 1px solid rgba(10, 36, 64, 0.15);
  border-radius: 6px;
  padding: 3px 8px;
}
.picodev-attribution a { color: var(--picodev-navy); text-decoration: none; }
.picodev-attribution a:hover { text-decoration: underline; }
`;

/* Only the editor and the examples are part of a rebranded instance. */
const NAV_STYLE = `
.header-nav-links .header-nav-link:not([href$="/examples"]):not([href$="/editor/"]) { display: none; }
`;

function injectStyle(): void {
  const el = document.createElement('style');
  el.dataset.picodev = 'overlay';
  el.textContent = STYLE + (REBRANDED ? NAV_STYLE : '');
  document.head.appendChild(el);
}

/**
 * AGPL attribution and source offer, always visible: the product is based on
 * Velxio and served over a network, so the corresponding source must be one
 * click away for every user.
 */
function injectAttribution(): void {
  const el = document.createElement('div');
  el.className = 'picodev-attribution';
  const link = (href: string, text: string): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  };
  el.append(
    `${BRAND_NAME} · powered by `,
    link(UPSTREAM_URL, 'Velxio'),
    ' (AGPLv3) · ',
    link(SOURCE_URL || UPSTREAM_SOURCE_URL, 'Code source'),
  );
  document.body.appendChild(el);
}

/** Pages set their own <title> ("… | Velxio"); keep the product name ours. */
function brandTitles(): void {
  const rebrand = () => {
    if (document.title.includes('Velxio')) {
      document.title = document.title.replace(/Velxio/g, BRAND_NAME);
    }
  };
  rebrand();
  new MutationObserver(rebrand).observe(document.head, { subtree: true, childList: true, characterData: true });
}

/**
 * The bench workspace, a page of its own next to Velxio's (bench/BenchPage).
 * Always registered: its links and its sheets come from the [bench] section
 * of the deployment file, and without one a setup is simply "introuvable".
 */
const BenchPage = lazy(() => import('./bench/BenchPage'));
/** The spectator page of a hub session ([hub] url); without a hub it says so. */
const SpectatorPage = lazy(() => import('./bench/SpectatorPage'));
const bench = (mode: 'free' | 'challenge') =>
  createElement(Suspense, { fallback: null }, createElement(BenchPage, { mode }));

export const mountPro = (): void => {
  registerProRoutes([
    { path: 'bench/:setupId', element: bench('free') },
    { path: 'bench/:setupId/challenge', element: bench('challenge') },
    { path: 'w/:sessionId', element: createElement(Suspense, { fallback: null }, createElement(SpectatorPage)) },
  ]);
  // The hosted-only boards and parts (« ONLINE ») point to velxio.com: not offered here.
  suppressOnlineOnlyAds([...ONLINE_ONLY_BOARD_ADS, ...ONLINE_ONLY_COMPONENT_ADS].map((ad) => ad.id));
  injectStyle();
  if (!REBRANDED) return;
  brandTitles();
  injectAttribution();
};
