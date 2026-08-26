/**
 * Bouwt de IIIF Presentation 3 Collection.
 *
 * Een Collection — niet een Manifest — is de manier waarop IIIF losse
 * manifesten bundelt, en het is wat viewers als Theseus als bladerbare
 * catalogus tonen.
 */
import type { DatasetMeta } from './dataset-description.ts';
import { collectionUrl } from './site.ts';
import type { ManifestEntry } from './manifests.ts';
import type { LangMap } from './rdf.ts';

/**
 * IIIF 3 staat in `rights` alleen Creative Commons- en RightsStatements-URI's
 * toe. Een andere licentie-URI hier zetten maakt de collection ongeldig.
 */
const RIGHTS_HOSTS = /^https?:\/\/(creativecommons\.org|rightsstatements\.org)\//;

export interface CollectionInput {
  uuid: string;
  baseUrl: string;
  meta: DatasetMeta;
  entries: ManifestEntry[];
  totalFound: number;
  created: string;
  titleOverride?: string;
  /** Het aantal manifest-IRI's dat de bron van deze dataset opleverde. */
  known: number;
  /** Waar die vandaan kwamen; bepaalt de herkomstvermelding. */
  source: 'dkg' | 'distributie';
}

export function buildCollection(input: CollectionInput): Record<string, unknown> {
  const { uuid, baseUrl, meta, entries, totalFound, created } = input;
  const language = meta.inLanguage ?? 'nl';
  const datasetName = pickLabel(meta.name) ?? meta.url;
  const title = input.titleOverride ?? `${datasetName} — steekproef van ${entries.length}`;

  const collection: Record<string, unknown> = {
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: collectionUrl(baseUrl, uuid),
    type: 'Collection',
    label: { [language]: [title] },
    summary: {
      [language]: [
        `Steekproef van ${entries.length} IIIF-manifesten uit de ` +
          `${totalFound.toLocaleString('nl-NL')} die het NDE Dataset Knowledge Graph ` +
          `aan deze dataset toeschrijft, samengesteld op ${created.slice(0, 10)}.`,
      ],
    },
    metadata: [
      {
        label: { nl: ['Herkomst van de steekproef'], en: ['Provenance'] },
        value: {
          nl: [
            input.source === 'distributie'
              ? `Gecontroleerde steekproef uit de ${input.known.toLocaleString('nl-NL')} ` +
                'IIIF-manifesten in de RDF-distributie van deze dataset, omdat het NDE ' +
                'Dataset Knowledge Graph er geen bruikbare vastlegt.'
              : `De ${input.known} manifesten die het NDE Dataset Knowledge Graph van deze ` +
                "dataset vastlegt, opgehaald bij NDE's eigen SHACL-validatie.",
          ],
        },
      },
    ],
  };

  if (meta.publisher?.name) {
    collection['requiredStatement'] = {
      label: { nl: ['Bron'], en: ['Source'] },
      value: meta.publisher.name,
    };
  }

  // Alleen opnemen als het echt een toegestane rights-URI is.
  if (meta.license && RIGHTS_HOSTS.test(meta.license)) collection['rights'] = meta.license;

  // Een IIIF Agent heeft zowel id als label verplicht; zonder allebei weglaten.
  if (meta.publisher?.iri && meta.publisher.name) {
    collection['provider'] = [
      {
        id: meta.publisher.iri,
        type: 'Agent',
        label: meta.publisher.name,
        homepage: [
          { id: meta.publisher.iri, type: 'Text', label: meta.publisher.name, format: 'text/html' },
        ],
      },
    ];
  }

  // Let op als hier ooit een tweede verwijzing bij komt (seeAlso, rendering):
  // twee verwijzingen met dezelfde `id` maar een ander `type` laat
  // @iiif/parser's normalize() afbreken op "Can only merge entities with
  // identical identifiers and type", waardoor de collection in Theseus,
  // Mirador en Clover niet meer laadt.
  collection['homepage'] = [
    {
      id: meta.url,
      type: 'Text',
      label: { [language]: [`Datasetbeschrijving: ${datasetName}`] },
      format: 'text/html',
    },
  ];

  collection['items'] = entries.map((entry) => {
    const item: Record<string, unknown> = {
      id: entry.id,
      type: 'Manifest',
      label: entry.label,
    };
    if (entry.thumbnail) item['thumbnail'] = entry.thumbnail;
    if (entry.summary) item['summary'] = entry.summary;
    if (entry.homepage) item['homepage'] = entry.homepage;
    return item;
  });

  return collection;
}

/** Eerste bruikbare waarde uit een taalmap, ongeacht de taal. */
export function pickLabel(map: LangMap | undefined): string | undefined {
  if (!map) return undefined;
  for (const key of ['nl', 'en', 'none', ...Object.keys(map)]) {
    const value = map[key]?.[0];
    if (value) return value;
  }
  return undefined;
}
