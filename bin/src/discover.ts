/**
 * iiif-steekproef — datasets met IIIF opzoeken
 *
 * Zoekt in de NDE Dataset Knowledge Graph naar datasets die IIIF-manifesten
 * bevatten en vult daarmee het configuratiebestand aan.
 *
 *   npx tsx src/discover.ts [opties]
 *
 * Het bestand wordt uitsluitend aangevuld, nooit herschreven: handmatige
 * toevoegingen, aantekeningen en uitgecommentarieerde regels blijven staan, en
 * een URI die er al in staat wordt overgeslagen.
 */
import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@lde/dataset-registry-client';
import { readExistingUris } from './config.ts';
import { sparqlSelect } from './sparql.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  config: resolve(HERE, '../datasets.txt'),
  dkg: 'https://sparql.netwerkdigitaalerfgoed.nl/dataset-knowledge-graph',
  register: 'https://datasetregister.netwerkdigitaalerfgoed.nl/sparql',
};

/**
 * De vorm waarmee de Dataset Knowledge Graph vastlegt dat er IIIF in een
 * dataset zit. Dit is de definitie die NDE's eigen indexer gebruikt
 * (dataset-register, packages/search-indexer/src/dkg-source.ts), geen
 * zelfbedachte heuristiek.
 *
 * Het filter op `.well-known/void` is nodig omdat elke dataset ook voorkomt als
 * `<iri>/.well-known/void#media` — een VoID-descriptorfragment, geen
 * datasetbeschrijving. Zonder dat filter krijg je alles dubbel.
 */
const IIIF_QUERY = `
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX dct:  <http://purl.org/dc/terms/>
SELECT ?dataset ?manifests ?triples WHERE {
  ?dataset void:subset ?subset .
  ?subset dct:conformsTo <http://iiif.io/api/presentation/> ;
          void:entities ?manifests .
  OPTIONAL { ?dataset void:triples ?triples }
  FILTER(!CONTAINS(STR(?dataset), "/.well-known/void"))
}
ORDER BY DESC(?manifests)`;

const USAGE = `iiif-steekproef — datasets met IIIF opzoeken en aan de lijst toevoegen

  npx tsx src/discover.ts [opties]

  -c, --config <bestand>   datasetlijst om aan te vullen    (${DEFAULTS.config})
      --max-triples <n>    sla grotere datasets over        (geen grens)
      --limit <n>          hoogstens n datasets toevoegen   (geen grens)
      --dry-run            toon wat er zou worden toegevoegd, schrijf niets
      --dkg <url>          endpoint knowledge graph         (${DEFAULTS.dkg})
      --register <url>     endpoint dataset register        (${DEFAULTS.register})
  -h, --help               deze uitleg
`;

const log = (message: string): void => void process.stderr.write(message + '\n');
const nl = (value: number): string => value.toLocaleString('nl-NL');

interface Found {
  uri: string;
  manifests: number;
  triples?: number;
  title?: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      'max-triples': { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean' },
      dkg: { type: 'string' },
      register: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stderr.write(USAGE);
    return;
  }

  const configPath = resolve(values.config ?? DEFAULTS.config);
  const dkg = values.dkg ?? DEFAULTS.dkg;
  const register = values.register ?? DEFAULTS.register;
  const maxTriples = positiveInt(values['max-triples'], undefined, '--max-triples');
  const limit = positiveInt(values.limit, undefined, '--limit');

  /* 1. Zoeken -------------------------------------------------------------- */
  log(`Dataset Knowledge Graph bevragen: ${dkg}`);
  const rows = await sparqlSelect(dkg, IIIF_QUERY);
  const all: Found[] = rows.flatMap((row) => {
    const uri = row['dataset'];
    if (!uri) return [];
    const triples = Number(row['triples']);
    return [
      {
        uri,
        manifests: Number(row['manifests']) || 0,
        ...(Number.isFinite(triples) ? { triples } : {}),
      },
    ];
  });
  log(
    `  ${nl(all.length)} datasets met IIIF, samen ` +
      `${nl(all.reduce((sum, f) => sum + f.manifests, 0))} manifesten`,
  );

  /* 2. Filteren ------------------------------------------------------------ */
  let found = all;
  if (maxTriples !== undefined) {
    const before = found.length;
    found = found.filter((f) => f.triples === undefined || f.triples <= maxTriples);
    log(`  ${before - found.length} overgeslagen: groter dan ${nl(maxTriples)} triples`);
  }
  if (limit !== undefined && found.length > limit) {
    log(`  beperkt tot de ${nl(limit)} met de meeste manifesten`);
    found = found.slice(0, limit);
  }

  /* 3. Titels ophalen ------------------------------------------------------ */
  await addTitles(found, register);

  /* 4. Vergelijken met wat er al staat ------------------------------------- */
  const existing = await readExistingUris(configPath);
  if (!existing.exists) log(`Configuratiebestand bestaat nog niet en wordt aangemaakt.`);
  if (existing.duplicates.length > 0) {
    // Niet stilzwijgend repareren: dat zou herschrijven betekenen, en juist dat
    // moet dit script nooit doen.
    log(`  let op: ${existing.duplicates.length} URI('s) staan al dubbel in het bestand:`);
    for (const uri of existing.duplicates.slice(0, 5)) log(`    ${uri}`);
  }

  const fresh = found.filter((f) => !existing.uris.has(f.uri));
  const skipped = found.filter((f) => existing.disabled.has(f.uri));
  log(
    `\n${nl(existing.uris.size)} al in ${configPath}` +
      ` — ${nl(found.length - fresh.length)} daarvan gevonden, ${nl(fresh.length)} nieuw`,
  );
  if (skipped.length > 0) {
    log(`  ${nl(skipped.length)} daarvan staan uitgecommentarieerd en blijven zo:`);
    for (const item of skipped.slice(0, 5)) log(`    ${item.title ?? item.uri}`);
    if (skipped.length > 5) log(`    ... en nog ${nl(skipped.length - 5)}`);
  }

  if (fresh.length === 0) {
    log('Niets toe te voegen.');
    return;
  }

  /* 5. Toevoegen ----------------------------------------------------------- */
  const block = renderBlock(fresh, existing.endsWithNewline);
  if (values['dry-run']) {
    log('\n--dry-run: er is niets weggeschreven. Dit zou erbij komen:\n');
    process.stdout.write(block);
    return;
  }

  await appendFile(configPath, block, 'utf8');
  log(`\n${nl(fresh.length)} toegevoegd aan ${configPath}`);
  log(`Totaal nu ${nl(existing.uris.size + fresh.length)} datasets.`);
}

/**
 * Titels uit het Dataset Register, via LDE's registry-client — het package is
 * precies hiervoor gemaakt. Een `$id`-criterium haalt alles in één call op.
 *
 * Titels zijn sierwerk: ze maken een lijst van honderd-en-nog-wat regels
 * leesbaar, maar als het register hapert gaat het toevoegen gewoon door.
 */
async function addTitles(found: Found[], register: string): Promise<void> {
  if (found.length === 0) return;
  log(`Titels ophalen uit het Dataset Register: ${register}`);
  try {
    const client = new Client(new URL(register));
    // `$id` staat in de documentatie van @lde/dataset-registry-client, maar niet
    // in het van LDkit afgeleide type van SearchCriteria.
    const results = await client.query({ $id: found.map((f) => f.uri) } as never);
    const titles = new Map<string, string>();
    for await (const dataset of results) {
      const title = Object.values(dataset.title)[0];
      if (title) titles.set(dataset.iri.toString(), title);
    }
    for (const item of found) item.title = titles.get(item.uri);
    log(`  ${nl(titles.size)} van ${nl(found.length)} teruggevonden`);
  } catch (error) {
    log(`  overgeslagen: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Het blok dat aan het configuratiebestand wordt geplakt. */
function renderBlock(fresh: Found[], endsWithNewline: boolean): string {
  const today = new Date().toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const lines = [
    // Eindigde het bestand niet op een nieuwe regel, dan zou de eerste regel
    // hieronder aan de laatste bestaande regel vastplakken.
    ...(endsWithNewline ? [] : ['']),
    '',
    `# --- gevonden met src/discover.ts op ${today} ---`,
    '',
  ];
  for (const item of fresh) {
    const label = item.title ?? '(geen titel in het register)';
    lines.push(`# ${label} — ${nl(item.manifests)} manifesten`, item.uri, '');
  }
  return lines.join('\n');
}

function positiveInt(
  value: string | undefined,
  fallback: number | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} verwacht een geheel getal >= 0, kreeg "${value}"`);
  }
  return parsed;
}

try {
  await main();
} catch (error) {
  log(`\nFout: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
