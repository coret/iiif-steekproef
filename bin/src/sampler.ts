/**
 * iiif-steekproef
 *
 * Publiceert per dataset een IIIF Presentation 3 Collection met de manifesten
 * die de NDE Dataset Knowledge Graph van die dataset kent.
 *
 *   npx tsx src/sampler.ts                    # alle datasets uit datasets.txt
 *   npx tsx src/sampler.ts <dataset-URI> ...  # alleen deze
 *
 * Voortgang gaat naar stderr, de gepubliceerde URL's naar stdout — zo is de
 * uitvoer bruikbaar in een pijplijn.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCollection, pickLabel } from './collection.ts';
import { readDatasetList, readUriList } from './config.ts';
import { describeDataset, type DatasetMeta } from './dataset-description.ts';
import {
  chooseDistribution,
  downloadDistribution,
  extractManifestUris,
  parseOptionsFor,
} from './distribution.ts';
import { DKG_ENDPOINT, fetchKnownManifests, type KnownManifests } from './knowledge-graph.ts';
import {
  browserCanFetch,
  dominantReason,
  makeRandom,
  sampleManifests,
  shuffle,
  summarize,
} from './manifests.ts';
import { REGISTER_ENDPOINT, fetchRegisterMeta } from './registry.ts';
import {
  collectionUrl,
  publishSite,
  readCatalogs,
  readFailures,
  theseusUrl,
  writeCollection,
  type CatalogEntry,
  type DatasetFailure,
  type FailureCategory,
} from './site.ts';
import { uuidv5 } from './uuid.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  /** De DKG legt er hoogstens tien per dataset vast. */
  count: 10,
  config: resolve(HERE, '../datasets.txt'),
  /** De uitzonderingslijst voor de workaround; ontbreken mag. */
  workaround: resolve(HERE, '../../etc/workaround-uris.txt'),
  /** Alleen de workaround downloadt iets; hier komt dat te staan. */
  dataDir: resolve(HERE, '../data'),
  /** De workaround heeft de hele dump, dus daar mag de greep groter zijn. */
  workaroundCount: 25,
  out: resolve(HERE, '../../root'),
  baseUrl: 'https://iiif-steekproef.coret.org',
  /**
   * Laag met opzet. Alle manifesten van één dataset staan bij dezelfde server,
   * en die servers zijn niet van ons: met 5 tegelijk liep bij Krantenpaginas
   * (Coda Apeldoorn) 4 van de 9 manifesten in een time-out, met 2 laadden ze
   * alle negen. Nu de DKG er hoogstens tien per dataset kent, is elk verloren
   * manifest er één te veel.
   */
  concurrency: 2,
};

/**
 * Een overschrijvende voortgangsteller heeft alleen zin op een terminal; in een
 * logbestand of pijplijn levert het een sliert onleesbare escape-codes op.
 */
const TTY = process.stderr.isTTY === true;
const CLEAR_LINE = '\r\u001b[2K';

const log = (message: string): void => void process.stderr.write(message + '\n');
const progress = (message: string): void => {
  if (TTY) process.stderr.write('\r    ' + message);
};
const endProgress = (): void => {
  if (TTY) process.stderr.write(CLEAR_LINE);
};
const nl = (value: number): string => value.toLocaleString('nl-NL');

const USAGE = `iiif-steekproef — IIIF-steekproeven uit erfgoeddatasets

  npx tsx src/sampler.ts [dataset-URI ...] [opties]

Zonder URI worden alle datasets uit het configuratiebestand bemonsterd.

  -c, --config <bestand> datasetlijst, één URI per regel  (${DEFAULTS.config})
  -n, --count <n>        hoogstens n manifesten           (${DEFAULTS.count})
      --seed <n>         reproduceerbare volgorde         (willekeurig)
      --out <dir>        publicatiemap                    (${DEFAULTS.out})
      --base-url <url>   publieke basis-URL               (${DEFAULTS.baseUrl})
      --max-attempts <n> te controleren manifesten        (4 x count)
      --concurrency <n>  parallelle manifest-checks       (${DEFAULTS.concurrency})
      --workaround <b>   uitzonderingslijst               (${DEFAULTS.workaround})
      --data-dir <dir>   downloadcache van de workaround  (${DEFAULTS.dataDir})
      --dkg <url>        endpoint knowledge graph         (${DKG_ENDPOINT})
      --register <url>   endpoint dataset register        (${REGISTER_ENDPOINT})
      --dry-run          niets schrijven, alleen rapporteren
  -h, --help             deze uitleg
`;

interface Options {
  count: number;
  concurrency: number;
  maxAttempts: number;
  seed: number;
  baseUrl: string;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      count: { type: 'string', short: 'n' },
      seed: { type: 'string' },
      out: { type: 'string' },
      'base-url': { type: 'string' },
      'max-attempts': { type: 'string' },
      concurrency: { type: 'string' },
      dkg: { type: 'string' },
      register: { type: 'string' },
      workaround: { type: 'string' },
      'data-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stderr.write(USAGE);
    return;
  }

  const count = positiveInt(values.count, DEFAULTS.count, '--count');
  const options: Options = {
    count,
    concurrency: positiveInt(values.concurrency, DEFAULTS.concurrency, '--concurrency'),
    maxAttempts: positiveInt(values['max-attempts'], count * 4, '--max-attempts'),
    // Zonder --seed een tijdgebonden basis, zodat elke run een andere volgorde
    // oplevert; mét --seed exact reproduceerbaar.
    seed: values.seed === undefined ? Date.now() >>> 0 : positiveInt(values.seed, 0, '--seed'),
    baseUrl: (values['base-url'] ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
  };
  const outputDir = resolve(values.out ?? DEFAULTS.out);

  // Zonder argumenten is het configuratiebestand leidend; met argumenten
  // bemonsteren we alleen die datasets en laten we de rest van de index staan.
  const partialRun = positionals.length > 0;
  const datasetUrls = partialRun
    ? positionals
    : await readDatasetList(resolve(values.config ?? DEFAULTS.config));

  log(`${datasetUrls.length} dataset${datasetUrls.length === 1 ? '' : 's'} te bemonsteren`);

  /* Twee endpoints, twee vragen — allebei één keer voor de hele run --------- */
  const dkg = values.dkg ?? DKG_ENDPOINT;
  log(`\nManifesten ophalen uit de Dataset Knowledge Graph: ${dkg}`);
  const known = await fetchKnownManifests(dkg);
  const withManifests = datasetUrls.filter((url) => known.has(url)).length;
  log(
    `  ${nl(known.size)} datasets met manifesten in de DKG, ` +
      `waarvan ${nl(withManifests)} van de ${nl(datasetUrls.length)} uit de lijst`,
  );

  const register = values.register ?? REGISTER_ENDPOINT;
  log(`Metadata ophalen uit het Dataset Register: ${register}`);
  const registered = await catchMeta(datasetUrls, register);
  log(`  ${nl(registered.size)} van ${nl(datasetUrls.length)} teruggevonden`);

  const workaroundPath = resolve(values.workaround ?? DEFAULTS.workaround);
  const workaround = await readUriList(workaroundPath);
  const dataDir = resolve(values['data-dir'] ?? DEFAULTS.dataDir);
  log(
    workaround.size === 0
      ? `Geen workarounds (${workaroundPath})\n`
      : `${nl(workaround.size)} dataset(s) met een workaround uit ${workaroundPath}\n`,
  );

  const entries: CatalogEntry[] = [];
  const failures: DatasetFailure[] = [];

  for (const [index, datasetUrl] of datasetUrls.entries()) {
    log(`[${index + 1}/${datasetUrls.length}] ${datasetUrl}`);
    try {
      // Per dataset een eigen afgeleide seed: de run als geheel blijft daardoor
      // reproduceerbaar, ook als er een dataset bijkomt of wegvalt.
      const result = await sampleDataset(
        datasetUrl,
        known.get(datasetUrl),
        registered.get(datasetUrl),
        { ...options, seed: (options.seed + index * 0x9e3779b1) >>> 0 },
      );
      entries.push(result.entry);
      if (!values['dry-run']) {
        await writeCollection(outputDir, result.entry.uuid, result.collection);
      }
      log(`  gereed: ${result.entry.sampled} manifesten\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Mét naam, want zonder collection is de URI het enige aanknopingspunt
      // dat de bezoeker anders heeft.
      const name = pickLabel(registered.get(datasetUrl)?.name);
      // Eén kapotte dataset mag de rest van de run niet meenemen.
      log(`  OVERGESLAGEN: ${reason}`);

      // De workaround verandert niets aan het feit dát de gewone weg mislukte:
      // die melding blijft staan, met erachter dat er alsnog een steekproef is.
      const note = workaround.has(datasetUrl)
        ? await runWorkaround(
            datasetUrl,
            registered.get(datasetUrl),
            dataDir,
            {
              ...options,
              count: DEFAULTS.workaroundCount,
              maxAttempts: DEFAULTS.workaroundCount * 4,
              seed: (options.seed + index * 0x9e3779b1) >>> 0,
            },
            async (result) => {
              entries.push(result.entry);
              if (!values['dry-run']) {
                await writeCollection(outputDir, result.entry.uuid, result.collection);
              }
            },
          )
        : '';

      const category: FailureCategory =
        error instanceof SampleFailure ? error.category : 'overig';
      const detail = error instanceof SampleFailure ? error.detail : undefined;

      failures.push({
        datasetUrl,
        ...(name === undefined ? {} : { datasetName: name }),
        reason: reason + note,
        category,
        ...(detail === undefined ? {} : { detail }),
      });
      log('');
    }
  }

  if (entries.length === 0) {
    throw new Error('Geen enkele dataset opgeleverd; er valt niets te publiceren.');
  }

  if (values['dry-run']) {
    log('--dry-run: er is niets weggeschreven.');
  } else {
    const ledger = await mergeLedger(await readCatalogs(outputDir), entries, partialRun);
    const failureLedger = await mergeFailures(
      await readFailures(outputDir),
      failures,
      partialRun ? datasetUrls : undefined,
    );
    const { indexPath } = await publishSite(outputDir, options.baseUrl, ledger, failureLedger);
    log(`Geschreven: ${indexPath} (${ledger.length} datasets, ${failureLedger.length} overgeslagen)\n`);
  }

  for (const entry of entries) {
    const url = collectionUrl(options.baseUrl, entry.uuid);
    process.stdout.write(`${entry.datasetName}\n  ${url}\n  ${theseusUrl(url)}\n`);
  }

  if (failures.length > 0) {
    log(`\n${failures.length} dataset(s) overgeslagen:`);
    for (const failure of failures) log(`  ${failure.datasetUrl}\n    ${failure.reason}`);
    process.exitCode = 1;
  }
}

/**
 * Metadata is sierwerk: zonder titel valt er nog steeds een collection te maken.
 * Hapert het register, dan gaat de run door en valt elke dataset terug op zijn
 * eigen datasetbeschrijving.
 */
async function catchMeta(uris: string[], register: string): Promise<Map<string, DatasetMeta>> {
  try {
    return await fetchRegisterMeta(uris, register);
  } catch (error) {
    log(`  overgeslagen: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

/**
 * Werkt de ledger bij met de resultaten van deze run.
 *
 * Bij een volledige run is het configuratiebestand leidend: wat er niet meer in
 * staat, verdwijnt uit de index. Het bijbehorende JSON-bestand blijft wél staan,
 * zodat een eerder gedeelde collection-URL blijft werken.
 * Bij een deelrun blijven de niet-bemonsterde datasets ongemoeid.
 */
async function mergeLedger(
  existing: CatalogEntry[],
  fresh: CatalogEntry[],
  partialRun: boolean,
): Promise<CatalogEntry[]> {
  const updated = new Map(fresh.map((entry) => [entry.datasetUrl, entry]));
  if (!partialRun) return fresh;

  const merged = existing.map((entry) => updated.get(entry.datasetUrl) ?? entry);
  const seen = new Set(existing.map((entry) => entry.datasetUrl));
  return [...merged, ...fresh.filter((entry) => !seen.has(entry.datasetUrl))];
}

/**
 * Dezelfde regel als voor de ledger: bij een volledige run vervangen de verse
 * uitkomsten alles, bij een deelrun blijven de datasets die niet aan de beurt
 * waren staan — inclusief hun eerdere fout.
 */
async function mergeFailures(
  existing: DatasetFailure[],
  fresh: DatasetFailure[],
  onlyForUrls: string[] | undefined,
): Promise<DatasetFailure[]> {
  if (onlyForUrls === undefined) return fresh;
  const touched = new Set(onlyForUrls);
  return [...existing.filter((failure) => !touched.has(failure.datasetUrl)), ...fresh];
}

/**
 * Een mislukking waarvan we weten waar hij onder valt, zodat de pagina de
 * meldingen per soort kan groeperen in plaats van de tekst te moeten uitpluizen.
 */
class SampleFailure extends Error {
  constructor(
    message: string,
    readonly category: FailureCategory,
    readonly detail?: string,
  ) {
    super(message);
  }
}

interface SampleResult {
  entry: CatalogEntry;
  collection: Record<string, unknown>;
}

/**
 * De workaround draaien en teruggeven wat er achter de foutmelding moet komen.
 *
 * Lukt het, dan is dat de markering waar de pagina op leunt; lukt het niet, dan
 * de tweede reden — want dan is het nuttiger te weten dat óók de distributie
 * niets opleverde dan alleen dat de DKG niets had.
 */
async function runWorkaround(
  datasetUrl: string,
  registered: DatasetMeta | undefined,
  dataDir: string,
  options: Options,
  keep: (result: SampleResult) => Promise<void>,
): Promise<string> {
  try {
    const result = await sampleFromDistribution(datasetUrl, registered, dataDir, options);
    await keep(result);
    log(`  workaround: ${result.entry.sampled} manifesten uit de distributie`);
    return ' * verwerkt via workaround';
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    log(`  workaround mislukt: ${why}`);
    return ` * workaround mislukt: ${why}`;
  }
}

/** De gewone keten voor één dataset: de manifesten die de DKG kent. */
async function sampleDataset(
  datasetUrl: string,
  known: KnownManifests | undefined,
  registered: DatasetMeta | undefined,
  options: Options,
): Promise<SampleResult> {
  if (!known || known.manifests.length === 0) {
    throw new SampleFailure(
      "De Dataset Knowledge Graph legt van deze dataset geen manifest-IRI's vast.",
      'geen-manifest-iris',
    );
  }

  const meta = registered ?? (await fallbackMeta(datasetUrl));
  log(`  ${pickLabel(meta.name) ?? datasetUrl}`);
  log(`  ${known.manifests.length} manifesten bekend, ${nl(known.total)} in de dataset`);

  return finishSample(datasetUrl, meta, known.manifests, {
    totalFound: known.total,
    known: known.manifests.length,
    source: 'dkg',
    options,
  });
}

/**
 * De workaround: de manifesten uit de RDF-distributie in plaats van uit de DKG.
 *
 * Alleen voor URI's uit `etc/workaround-uris.txt`, en alleen nadat de gewone weg
 * is mislukt. De dump downloaden en uitlezen is duur genoeg om er niet standaard
 * aan te beginnen — daarom is dit een uitzonderingslijst en geen automatisme.
 */
async function sampleFromDistribution(
  datasetUrl: string,
  registered: DatasetMeta | undefined,
  dataDir: string,
  options: Options,
): Promise<SampleResult> {
  const described = await describeDataset(datasetUrl);
  const meta = registered ?? described.meta;
  log(`  workaround: ${described.distributions.length} distributie(s) in de beschrijving`);

  const distribution = await chooseDistribution(described.distributions, log);
  const path = await downloadDistribution(distribution, dataDir, log);

  const extraction = await extractManifestUris(
    path,
    await parseOptionsFor(distribution),
    (quads) => progress(`${nl(quads)} triples...`),
  );
  endProgress();

  if (extraction.usedFallback) {
    log(
      '  let op: geen schema:encodingFormat met IIIF-context gevonden; ' +
        'teruggevallen op het manifest-URL-patroon',
    );
  }
  if (extraction.uris.length === 0) {
    throw new Error(
      `geen IIIF-manifesten in ${distribution.accessUrl} ` +
        `(${nl(extraction.quads)} triples gelezen)`,
    );
  }
  log(`  ${nl(extraction.uris.length)} manifesten in ${nl(extraction.quads)} triples`);

  return finishSample(datasetUrl, meta, extraction.uris, {
    totalFound: extraction.uris.length,
    known: extraction.uris.length,
    source: 'distributie',
    options,
  });
}

/**
 * Het stuk dat beide routes delen: schudden, controleren wat écht laadt, en er
 * een collection van maken. Waar de kandidaten vandaan komen doet hier niet meer
 * toe — behalve dat `source` in de ledger belandt, zodat de pagina de herkomst
 * kan noemen.
 */
async function finishSample(
  datasetUrl: string,
  meta: DatasetMeta,
  candidates: string[],
  context: {
    totalFound: number;
    known: number;
    source: 'dkg' | 'distributie';
    options: Options;
  },
): Promise<SampleResult> {
  const { totalFound, known, source, options } = context;
  const datasetName = pickLabel(meta.name) ?? datasetUrl;

  const shuffled = shuffle(candidates, makeRandom(options.seed));
  let checked = 0;
  const sample = await sampleManifests(
    shuffled,
    options.count,
    options.maxAttempts,
    options.concurrency,
    () => progress(`${++checked} manifesten gecontroleerd...`),
  );
  endProgress();

  if (sample.entries.length === 0) {
    throw new SampleFailure(
      `Geen enkel manifest laadt (${sample.attempted} gecontroleerd): ` +
        summarize(sample.rejections),
      'laadt-niet',
      dominantReason(sample.rejections),
    );
  }
  if (sample.rejections.length > 0) log(`  afgekeurd: ${summarize(sample.rejections)}`);

  const cors = await checkCors(sample.entries, options.baseUrl);
  const where = cors?.blockedAt;
  const at = where === undefined ? '' : ` (stap ${where.hop}: ${where.host}, HTTP ${where.status})`;
  if (cors?.manifests === false) log(`  let op: een browser mag het manifest niet ophalen${at}`);
  if (cors?.images === false) log(`  let op: een browser mag info.json niet ophalen${at}`);

  // UUIDv5 uit de dataset-URI: de collection-URL blijft tussen runs gelijk, dus
  // een gedeelde of opgeslagen link blijft werken terwijl de inhoud ververst —
  // en ook als een dataset van route wisselt.
  const uuid = uuidv5(datasetUrl);
  const created = new Date().toISOString();

  return {
    collection: buildCollection({
      uuid,
      baseUrl: options.baseUrl,
      meta,
      created,
      entries: sample.entries,
      totalFound,
      known,
      source,
    }),
    entry: {
      uuid,
      created,
      datasetUrl,
      datasetName,
      datasetDescription: pickLabel(meta.description),
      publisher: pickLabel(meta.publisher?.name),
      sampled: sample.entries.length,
      totalFound,
      known,
      source,
      rejected: sample.rejections,
      cors,
      firstManifest: sample.entries[0]!.id,
    },
  };
}

/**
 * Wat de browser van deze bron mag ophalen.
 *
 * Twee losse vragen, allebei via de ketencontrole: een bron kan het manifest
 * wél vrijgeven en `info.json` niet, en dan blijft de viewer leeg terwijl er
 * niets mis is met het manifest. Eén manifest en één beeldservice per dataset
 * volstaan — ze staan bij dezelfde bron en lopen langs dezelfde keten.
 */
async function checkCors(
  entries: { sourceUri: string; imageService?: string }[],
  origin: string,
): Promise<CatalogEntry['cors']> {
  const first = entries[0];
  const manifest = first ? await browserCanFetch(first.sourceUri, origin) : { ok: null };

  const service = entries.find((entry) => entry.imageService)?.imageService;
  const images =
    service === undefined ? { ok: null } : await browserCanFetch(service + '/info.json', origin);

  const blocked = manifest.ok === false ? manifest.blockedAt : images.blockedAt;
  return {
    manifests: manifest.ok,
    images: images.ok,
    ...(blocked === undefined
      ? {}
      : {
          blockedAt: {
            host: new URL(blocked.url).host,
            status: blocked.status,
            hop: blocked.hop,
          },
        }),
  };
}

/**
 * Kent het register de dataset niet, dan de datasetbeschrijving van de uitgever
 * zelf proberen. Levert ook dat niets op, dan draagt de collection alleen de
 * URI als naam — beter dan de dataset helemaal laten vallen.
 */
async function fallbackMeta(datasetUrl: string): Promise<DatasetMeta> {
  try {
    const { meta } = await describeDataset(datasetUrl);
    log('  metadata uit de datasetbeschrijving (niet in het register)');
    return meta;
  } catch {
    log('  let op: geen metadata gevonden, alleen de URI');
    return { url: datasetUrl };
  }
}

function positiveInt(value: string | undefined, fallback: number, flag: string): number {
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
