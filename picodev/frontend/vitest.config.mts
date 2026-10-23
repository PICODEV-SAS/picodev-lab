/**
 * The overlay's tests, run with Velxio's vitest:
 *   cd frontend && npx vitest run --root ../picodev/frontend
 * The overlay has no node_modules of its own: React comes from Velxio's.
 */
import { fileURLToPath } from 'node:url';

const velxio = fileURLToPath(new URL('../../frontend/node_modules/', import.meta.url));

export default {
  resolve: { alias: { '@velxio': fileURLToPath(new URL('../../frontend/src', import.meta.url)), react: `${velxio}react`, 'react-dom': `${velxio}react-dom` } },
  esbuild: { jsx: 'automatic' },
  // Velxio's own limits: compiling a sketch with arduino-cli takes a while.
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
};
