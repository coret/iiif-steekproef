/**
 * De workaround-route: manifest-IRI's rechtstreeks uit de RDF-distributie.
 *
 * De gewone weg loopt via het Dataset Knowledge Graph. Voor sommige datasets
 * legt dat niets bruikbaars vast terwijl de distributie wél deugt; die staan in
 * `etc/workaround-uris.txt` en komen hier terecht.
 *
 * Distributie kiezen en ophalen doet LD Elements — `@lde/distribution-probe`
 * en `@lde/distribution-downloader`. Het uitlezen van de dump niet: LDE's
 * antwoord daarop is hem in een SPARQL-store importeren (`ImportResolver`,
 * `@lde/sparql-qlever`), en juist die zwaarte willen we hier niet. Vandaar
 * streamend parsen met rdf-parse, dat toch al in de keten zit.
 */
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { Distribution } from '@lde/dataset';
import { LastModifiedDownloader } from '@lde/distribution-downloader';
import { NetworkError, probe } from '@lde/distribution-probe';
import type { ParseOptions } from 'rdf-parse';
import { detectParseOptions, isGzip, parseQuads, schema } from './rdf.ts';

/** Alles wat een IIIF Presentation-context noemt, welke versie dan ook. */
const IIIF_CONTEXT = 'iiif.io/api/presentation/';

const ENCODING_FORMAT = new Set(schema('encodingFormat'));

/** Predicaten die in de praktijk naar een manifest wijzen, voor de terugval. */
const MANIFEST_LINKS = new Set(schema('isBasedOn', 'subjectOf', 'mainEntityOfPage', 'url'));
const MANIFEST_URL = /\/manifest(\.json|\.jsonld)?$/i;

/**
 * Voorkeursvolgorde. N-Triples eerst: regelgebaseerd, geen documentstructuur om
 * bij te houden, dus het goedkoopst om streamend te lezen. JSON-LD als laatste
 * om de omgekeerde reden.
 */
const PREFERRED = [
  'application/n-triples',
  'application/n-quads',
  'text/turtle',
  'application/trig',
  'application/rdf+xml',
  'application/ld+json',
];

function rank(distribution: Distribution): number {
  const position = PREFERRED.indexOf(distribution.mimeType ?? '');
  return position === -1 ? PREFERRED.length : position;
}

/**
 * De eerste distributie die de probe overleeft, op voorkeursvolgorde.
 *
 * `probe()` gooit nooit: een onbereikbare distributie komt terug als
 * `NetworkError` en dan gaan we door naar de volgende.
 */
export async function chooseDistribution(
  distributions: Distribution[],
  log: (message: string) => void,
): Promise<Distribution> {
  if (distributions.length === 0) throw new Error('De dataset heeft geen enkele distributie.');

  const ordered = [...distributions].sort((a, b) => rank(a) - rank(b));
  const problems: string[] = [];

  for (const distribution of ordered) {
    const result = await probe(distribution);
    if (result instanceof NetworkError) {
      problems.push(`${distribution.accessUrl}: ${result.message}`);
      continue;
    }
    if (!result.isSuccess()) {
      problems.push(`${distribution.accessUrl}: ${result.failureReason ?? result.statusCode}`);
      continue;
    }
    // Wat de probe over het bestand te weten kwam doorgeven aan de downloader:
    // zonder `lastModified` slaat die de download nooit over, en dan is de cache
    // een lege huls. Servers die het niet sturen (Atlantis bijvoorbeeld) blijven
    // elke run opnieuw leveren — daar valt van onze kant niets aan te doen.
    if (result.lastModified !== null) distribution.lastModified = result.lastModified;
    if (distribution.byteSize === undefined && 'contentSize' in result && result.contentSize) {
      distribution.byteSize = result.contentSize;
    }

    log(`  distributie: ${distribution.mimeType ?? 'onbekend'} — ${distribution.accessUrl}`);
    return distribution;
  }

  throw new Error(
    `Geen bruikbare distributie (${problems.length} geprobeerd): ${problems.slice(0, 3).join('; ')}`,
  );
}

/** Downloadt naar de cache; een actuele kopie wordt niet opnieuw gehaald. */
export async function downloadDistribution(
  distribution: Distribution,
  dataDir: string,
  log: (message: string) => void,
): Promise<string> {
  const { path } = await new LastModifiedDownloader(dataDir).download(distribution);
  log(`  opgehaald naar ${path}`);
  return path;
}

export interface Extraction {
  uris: string[];
  quads: number;
  /** True als de primaire detectie niets opleverde en de terugval het deed. */
  usedFallback: boolean;
}

/**
 * Leest de dump en verzamelt de manifest-URI's.
 *
 * Primaire detectie: een IRI-subject met `schema:encodingFormat` waarin de IIIF
 * Presentation-context staat. Dat is hoe de NDE-profielen het voorschrijven en
 * hoe publicatiesoftware het in de praktijk uitrolt.
 */
export async function extractManifestUris(
  path: string,
  options: ParseOptions,
  onProgress: (quads: number) => void,
): Promise<Extraction> {
  const primary = new Set<string>();
  const fallback = new Set<string>();
  let quads = 0;

  await parseQuads(await openDump(path), options, (quad) => {
    if (++quads % 250_000 === 0) onProgress(quads);
    if (
      quad.subject.termType === 'NamedNode' &&
      ENCODING_FORMAT.has(quad.predicate.value) &&
      quad.object.value.includes(IIIF_CONTEXT)
    ) {
      primary.add(flat(quad.subject.value));
    } else if (
      quad.object.termType === 'NamedNode' &&
      MANIFEST_LINKS.has(quad.predicate.value) &&
      MANIFEST_URL.test(quad.object.value)
    ) {
      fallback.add(flat(quad.object.value));
    }
  });
  onProgress(quads);

  const usedFallback = primary.size === 0 && fallback.size > 0;
  return { uris: [...(usedFallback ? fallback : primary)], quads, usedFallback };
}

/**
 * Een platte kopie van de string, en dat is hier geen overbodige voorzichtigheid.
 *
 * De parser levert IRI's als deelstrings van de leesbuffer. Wie er één bewaart,
 * houdt daarmee de hele chunk in leven: gemeten 13,6 KB heap per bewaarde URI
 * van zo'n 70 bytes. Bij het Nederlands Fotomuseum liep dat na 273.000 URI's
 * tegen de heap-limiet van Node aan en stierf het proces. Deze kopie maakt de
 * string los van zijn buffer.
 */
function flat(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}

/** Opent de dump, met gunzip ertussen als de bytes daarom vragen. */
async function openDump(path: string): Promise<Readable> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    const stream = createReadStream(path);
    return isGzip(head) ? stream.pipe(createGunzip()) : stream;
  } finally {
    await handle.close();
  }
}

/** Hoe rdf-parse deze dump moet lezen. */
export function parseOptionsFor(distribution: Distribution): Promise<ParseOptions> {
  return detectParseOptions({
    ...(distribution.mimeType === undefined ? {} : { contentType: distribution.mimeType }),
    url: distribution.accessUrl.toString(),
  });
}
