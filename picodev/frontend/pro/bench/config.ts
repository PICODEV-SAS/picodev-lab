/**
 * The [bench] section of the deployment file, as /config.js exposes it
 * (picodev/docker/render_config.py). With no section the routes still work
 * on neutral paths: a sheet that is not there gives the "setup introuvable"
 * page, which is the only state an unconfigured instance needs.
 */
interface BenchConfig {
  /** [brand] logo_url: empty when the deployment has no logo. */
  logoUrl?: string;
  setupsUrl?: string;
  exitUrl?: string;
  homeUrl?: string;
  /** [hub] url: absent, the bench never calls a hub (v0.2 behaviour). */
  hubUrl?: string;
}

const runtime = (globalThis as { __LAB_CONFIG__?: BenchConfig }).__LAB_CONFIG__ ?? {};

export const SETUPS_URL = (runtime.setupsUrl || '/setups').replace(/\/+$/, '');
export const EXIT_URL = runtime.exitUrl || '/';
export const LOGO_URL = runtime.logoUrl || '';
export const HOME_URL = runtime.homeUrl || '/';
export const HUB_URL = (runtime.hubUrl || '').replace(/\/+$/, '');
