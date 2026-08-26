/**
 * Bouwt index.html opnieuw op uit catalogs.json, zonder opnieuw te bemonsteren.
 *
 *   npx tsx src/render.ts [--out <dir>] [--base-url <url>]
 *
 * Handig na een wijziging in het sjabloon in site.ts, en om lokaal te testen
 * met een andere basis-URL (bijv. http://localhost:8099).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publishSite, readCatalogs, readFailures } from './site.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'base-url': { type: 'string' },
  },
});

const outputDir = resolve(values.out ?? resolve(HERE, '../../root'));
const baseUrl = (values['base-url'] ?? 'https://iiif-steekproef.coret.org').replace(/\/+$/, '');

const entries = await readCatalogs(outputDir);
if (entries.length === 0) {
  process.stderr.write(`Geen catalogs.json in ${outputDir}; draai eerst src/sampler.ts.\n`);
  process.exit(1);
}

const failures = await readFailures(outputDir);
const { indexPath } = await publishSite(outputDir, baseUrl, entries, failures);
process.stderr.write(
  `${indexPath} opnieuw gegenereerd (${entries.length} datasets, ` +
    `${failures.length} overgeslagen, ${baseUrl})\n`,
);
