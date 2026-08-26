/**
 * Gedeelde RDF-helpers: namespaces, het streamend parsen van een RDF-document,
 * en een kleine in-memory index voor documenten die klein genoeg zijn om
 * helemaal in te lezen (zoals een datasetbeschrijving).
 */
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { rdfParser, type ParseOptions } from 'rdf-parse';
import type * as RDF from '@rdfjs/types';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const DCAT = 'http://www.w3.org/ns/dcat#';
export const DCT = 'http://purl.org/dc/terms/';

/**
 * schema.org bestaat in twee namespaces. De datasetbeschrijving van Kamp
 * Westerbork gebruikt het legacy `http://`, de distributie het moderne
 * `https://`. Wie er maar één afvangt, ziet een lege dataset.
 */
export function schema(...names: string[]): string[] {
  return names.flatMap((name) => [
    `https://schema.org/${name}`,
    `http://schema.org/${name}`,
  ]);
}

export const USER_AGENT =
  'iiif-catalog-sampler/1.0 (+https://lab.coret.org/iiif-catalog-sampler/)';

/** Content-type zonder parameters, bijv. `application/ld+json; charset=utf-8`. */
export function bareContentType(header: string | null): string | undefined {
  const bare = header?.split(';')[0]?.trim().toLowerCase();
  return bare && bare.length > 0 ? bare : undefined;
}

/**
 * Parse een RDF-stream naar quads en geef ze door aan `onQuad`.
 *
 * Bewust event-gebaseerd in plaats van `for await`: dat is de vorm die
 * rdf-parse gegarandeerd ondersteunt, ongeacht de onderliggende stream-variant.
 */
export function parseQuads(
  input: Readable,
  options: ParseOptions,
  onQuad: (quad: RDF.Quad) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const quads = rdfParser.parse(input, options);
    quads.on('data', onQuad);
    quads.on('error', reject);
    quads.on('end', () => resolve());
    input.on('error', reject);
  });
}

/**
 * Content-types die alleen zeggen "dit zijn samengeperste bytes" en dus niets
 * vertellen over de RDF-serialisatie erbinnen.
 */
const COMPRESSION_TYPES = new Set([
  'application/gzip',
  'application/x-gzip',
  'application/zip',
  'application/octet-stream',
]);

/** Gzip-magic bytes. */
export function isGzip(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Bepaal hoe rdf-parse dit document moet lezen.
 *
 * Volgorde: een bruikbaar content-type wint; anders de bestandsnaam uit
 * `Content-Disposition`; anders de extensie van de URL. Compressie-content-types
 * worden genegeerd — die beschrijven de verpakking, niet de inhoud.
 *
 * Dit is geen theoretische zorgvuldigheid: de Atlantis-server van Kamp
 * Westerbork stuurt `content-type: application/x-gzip` met een
 * `Content-Disposition`-bestandsnaam op `.jsonld`, en de URL zelf heeft
 * helemaal geen extensie.
 */
export async function detectParseOptions(source: {
  contentType?: string;
  contentDisposition?: string | null;
  url: string;
}): Promise<ParseOptions> {
  const known = await rdfParser.getContentTypes();
  if (
    source.contentType &&
    !COMPRESSION_TYPES.has(source.contentType) &&
    known.includes(source.contentType)
  ) {
    return { contentType: source.contentType, baseIRI: source.url };
  }

  const filename = source.contentDisposition?.match(/filename\*?=\"?([^\";]+)/i)?.[1];
  const fromDisposition = extensionPath(filename);
  if (fromDisposition) return { path: fromDisposition, baseIRI: source.url };

  const fromUrl = extensionPath(safePathname(source.url));
  if (fromUrl) return { path: fromUrl, baseIRI: source.url };

  throw new Error(
    `Kan de RDF-serialisatie niet bepalen voor ${source.url} ` +
      `(content-type: ${source.contentType ?? 'onbekend'}).`,
  );
}

/**
 * Maakt van een bestandsnaam een pad dat rdf-parse's extensie-detectie aankan,
 * met een eventueel `.gz`-achtervoegsel eraf.
 */
function extensionPath(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const stripped = name.replace(/\.(gz|gzip|zip|bz2)$/i, '');
  return /\.[a-z0-9]+$/i.test(stripped) ? stripped : undefined;
}

function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Haalt een RDF-document op en levert het klaar-om-te-parsen op.
 *
 * `accept-encoding: identity` is essentieel: servers die gzip als *body* leveren
 * (in plaats van als transfer-encoding) laten undici de bytes niet uitpakken,
 * en je houdt dan onleesbare bytes over met een misleidend content-type. Voor
 * de zekerheid wordt gzip alsnog aan de magic bytes herkend en uitgepakt.
 */
export async function fetchRdf(
  url: string,
  accept: string,
): Promise<{ stream: Readable; options: ParseOptions; finalUrl: string }> {
  const response = await fetch(url, {
    headers: { accept, 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(
      `Ophalen mislukt: HTTP ${response.status} ${response.statusText} — ${url}`,
    );
  }

  const finalUrl = response.url || url;
  let body = Buffer.from(await response.arrayBuffer());
  if (isGzip(body)) body = gunzipSync(body);

  return {
    stream: Readable.from(body),
    options: await detectParseOptions({
      contentType: bareContentType(response.headers.get('content-type')),
      contentDisposition: response.headers.get('content-disposition'),
      url: finalUrl,
    }),
    finalUrl,
  };
}

/** Alle objecten van `subject` voor één van `predicates`. */
export type QuadIndex = Map<string, Map<string, RDF.Term[]>>;

export function indexQuad(index: QuadIndex, quad: RDF.Quad): void {
  const subject = index.get(quad.subject.value) ?? new Map<string, RDF.Term[]>();
  const objects = subject.get(quad.predicate.value) ?? [];
  objects.push(quad.object);
  subject.set(quad.predicate.value, objects);
  index.set(quad.subject.value, subject);
}

export function objects(
  index: QuadIndex,
  subject: string,
  predicates: string[],
): RDF.Term[] {
  const properties = index.get(subject);
  if (!properties) return [];
  return predicates.flatMap((predicate) => properties.get(predicate) ?? []);
}

export function firstValue(
  index: QuadIndex,
  subject: string,
  predicates: string[],
): string | undefined {
  return objects(index, subject, predicates)[0]?.value;
}

/** IIIF-taalmap: `"tekst"@nl` wordt `{ nl: ["tekst"] }`, zonder taal `none`. */
export type LangMap = Record<string, string[]>;

export function toLangMap(terms: RDF.Term[]): LangMap | undefined {
  const map: LangMap = {};
  for (const term of terms) {
    if (term.termType !== 'Literal') continue;
    const language = term.language || 'none';
    (map[language] ??= []).push(term.value);
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export function langMapOf(
  index: QuadIndex,
  subject: string,
  predicates: string[],
): LangMap | undefined {
  return toLangMap(objects(index, subject, predicates));
}

