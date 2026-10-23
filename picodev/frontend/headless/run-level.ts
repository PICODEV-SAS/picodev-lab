/**
 * node run-level.mjs --sheet setup.json --level niveau-1 --hex sketch.hex [--lang en]
 *
 * Prints the report of the level as JSON on stdout. Exit code 0 when every
 * test passed, 1 when one failed, 2 when the run could not happen.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runHeadless } from './headless';

// The simulator logs to the console; stdout is for the report only.
console.log = console.info = console.debug = () => {};

try {
  const { values } = parseArgs({
    options: {
      sheet: { type: 'string' },
      level: { type: 'string' },
      hex: { type: 'string' },
      lang: { type: 'string', default: 'fr' },
    },
  });
  const { sheet, level, hex, lang } = values;
  if (!sheet || !level || !hex) throw new Error('usage: run-level --sheet setup.json --level <id> --hex sketch.hex [--lang fr|en]');
  if (lang !== 'fr' && lang !== 'en') throw new Error(`--lang: fr or en, not "${lang}"`);
  const report = await runHeadless(JSON.parse(readFileSync(sheet, 'utf8')), level, readFileSync(hex, 'utf8'), lang);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.passed ? 0 : 1;
} catch (e) {
  console.error(`run-level: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
