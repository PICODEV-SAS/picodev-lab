/**
 * The overlay's tests, run with Velxio's vitest:
 *   cd frontend && npx vitest run --root ../picodev/frontend
 * The overlay has no node_modules of its own: React comes from Velxio's.
 */
import { fileURLToPath } from 'node:url';

const velxio = fileURLToPath(new URL('../../frontend/node_modules/', import.meta.url));

export default {
  resolve: { alias: { react: `${velxio}react`, 'react-dom': `${velxio}react-dom` } },
  esbuild: { jsx: 'automatic' },
};
