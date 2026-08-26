/**
 * Leest de datasetbeschrijving van een uitgever uit.
 *
 * Dit is de terugval voor datasets die het Dataset Register niet kent: één
 * losse beschrijvings-URL, in schema.org of DCAT, in elke RDF-serialisatie die
 * rdf-parse aankan. `@lde/dataset-registry-client` kan dat niet — dat bevraagt
 * een registry-SPARQL-endpoint, geen losse URL.
 *
 * Levert de metadata én de distributies op. De metadata is de terugval voor de
 * titel; de distributies zijn er alleen voor de workaround-route, die de dump
 * uitleest als het DKG niets bruikbaars vastlegt.
 */
import { Distribution } from '@lde/dataset';
import {
  DCAT,
  DCT,
  RDF_TYPE,
  fetchRdf,
  firstValue,
  indexQuad,
  langMapOf,
  objects,
  parseQuads,
  schema,
  type LangMap,
  type QuadIndex,
} from './rdf.ts';

export interface DatasetMeta {
  /** De URL zoals opgegeven, na eventuele redirects. */
  url: string;
  name?: LangMap;
  description?: LangMap;
  /** Licentie-IRI, indien aanwezig. */
  license?: string;
  publisher?: { iri?: string; name?: LangMap };
  inLanguage?: string;
}

const ACCEPT =
  'application/ld+json, text/turtle;q=0.9, application/rdf+xml;q=0.8, ' +
  'application/n-triples;q=0.8, */*;q=0.1';

export interface DescribedDataset {
  meta: DatasetMeta;
  /** Leeg als de beschrijving er geen noemt; dat is geen fout. */
  distributions: Distribution[];
}

export async function describeDataset(url: string): Promise<DescribedDataset> {
  const { stream, options, finalUrl } = await fetchRdf(url, ACCEPT);

  const index: QuadIndex = new Map();
  await parseQuads(stream, options, (quad) => indexQuad(index, quad));

  if (index.size === 0) {
    throw new Error(`Geen RDF gevonden in de datasetbeschrijving — ${finalUrl}`);
  }

  const subject = findDatasetSubject(index, finalUrl);
  if (!subject) {
    throw new Error(
      `Geen schema:Dataset of dcat:Dataset gevonden in ${finalUrl}. ` +
        `Gevonden subjects: ${[...index.keys()].slice(0, 5).join(', ')}`,
    );
  }

  return {
    meta: readMeta(index, subject, finalUrl),
    distributions: [
      ...readDistributions(index, subject, schema('distribution'), schema('contentUrl', 'url'), [
        ...schema('encodingFormat', 'fileFormat'),
      ]),
      ...readDistributions(
        index,
        subject,
        [`${DCAT}distribution`],
        [`${DCAT}downloadURL`, `${DCAT}accessURL`],
        [`${DCAT}mediaType`, `${DCT}format`],
      ),
    ],
  };
}

/**
 * schema.org en DCAT beschrijven een distributie hetzelfde maar met andere
 * predicaten, dus één lezer met de predicaten als parameter.
 */
function readDistributions(
  index: QuadIndex,
  subject: string,
  linkPredicates: string[],
  urlPredicates: string[],
  formatPredicates: string[],
): Distribution[] {
  const distributions: Distribution[] = [];
  for (const node of objects(index, subject, linkPredicates)) {
    const url = safeUrl(firstValue(index, node.value, urlPredicates));
    if (!url) continue;
    const distribution = new Distribution(url, firstValue(index, node.value, formatPredicates));

    const compress = firstValue(index, node.value, [`${DCAT}compressFormat`]);
    if (compress) distribution.compressFormat = compress;
    const size = Number(
      firstValue(index, node.value, [...schema('contentSize'), `${DCAT}byteSize`]),
    );
    if (Number.isFinite(size) && size > 0) distribution.byteSize = size;

    distributions.push(distribution);
  }
  return distributions;
}

function safeUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const DATASET_TYPES = new Set([...schema('Dataset'), `${DCAT}Dataset`]);

function findDatasetSubject(index: QuadIndex, url: string): string | undefined {
  const candidates: string[] = [];
  for (const [subject, properties] of index) {
    const types = properties.get(RDF_TYPE) ?? [];
    if (types.some((type) => DATASET_TYPES.has(type.value))) candidates.push(subject);
  }
  // Bij meerdere datasets in één document wint degene die de opgevraagde URL is.
  return candidates.find((candidate) => candidate === url) ?? candidates[0];
}

function readMeta(index: QuadIndex, subject: string, url: string): DatasetMeta {
  const publisherIri = firstValue(index, subject, schema('publisher', 'creator'));
  return {
    url,
    name: langMapOf(index, subject, [...schema('name'), `${DCT}title`]),
    description: langMapOf(index, subject, [...schema('description'), `${DCT}description`]),
    license: firstValue(index, subject, [...schema('license'), `${DCT}license`]),
    publisher: publisherIri
      ? { iri: publisherIri, name: langMapOf(index, publisherIri, schema('name')) }
      : undefined,
    inLanguage: firstValue(index, subject, [...schema('inLanguage'), `${DCT}language`]),
  };
}
