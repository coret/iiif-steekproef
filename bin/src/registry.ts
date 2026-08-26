/**
 * Datasetmetadata uit het NDE Dataset Register.
 *
 * Zolang de manifesten uit de datasetbeschrijving van de uitgever zelf kwamen,
 * kwam de titel daar ook vandaan. Nu de manifesten uit de Dataset Knowledge
 * Graph komen, hoeft die beschrijving niet meer opgehaald te worden — en dan is
 * het register de aangewezen bron: één query levert de metadata van alle
 * datasets tegelijk, in plaats van 135 losse verzoeken aan evenzoveel servers.
 */
import { Client } from '@lde/dataset-registry-client';
import type { DatasetMeta } from './dataset-description.ts';
import type { LangMap } from './rdf.ts';

export const REGISTER_ENDPOINT =
  'https://datasetregister.netwerkdigitaalerfgoed.nl/sparql';

/**
 * De metadata van de opgegeven datasets, op dataset-URI.
 *
 * Datasets die het register niet kent ontbreken gewoon in de uitkomst; de
 * aanroeper beslist wat dat betekent.
 */
export async function fetchRegisterMeta(
  uris: string[],
  endpoint: string = REGISTER_ENDPOINT,
): Promise<Map<string, DatasetMeta>> {
  const found = new Map<string, DatasetMeta>();
  if (uris.length === 0) return found;

  const client = new Client(new URL(endpoint));
  // `$id` staat in de documentatie van @lde/dataset-registry-client, maar niet
  // in het van LDkit afgeleide type van SearchCriteria.
  for await (const dataset of await client.query({ $id: uris } as never)) {
    const url = dataset.iri.toString();
    found.set(url, {
      url,
      ...(toLangMap(dataset.title) ? { name: toLangMap(dataset.title)! } : {}),
      ...(toLangMap(dataset.description) ? { description: toLangMap(dataset.description)! } : {}),
      ...(dataset.license ? { license: dataset.license.toString() } : {}),
      ...(dataset.publisher
        ? {
            publisher: {
              iri: dataset.publisher.iri.toString(),
              ...(toLangMap(dataset.publisher.name)
                ? { name: toLangMap(dataset.publisher.name)! }
                : {}),
            },
          }
        : {}),
      ...(dataset.language[0] ? { inLanguage: dataset.language[0] } : {}),
    });
  }
  return found;
}

/** Het register geeft één waarde per taal, een IIIF-taalmap heeft er een lijst. */
function toLangMap(value: Record<string, string> | undefined): LangMap | undefined {
  if (!value) return undefined;
  const map: LangMap = {};
  for (const [language, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.length > 0) map[language] = [text];
  }
  return Object.keys(map).length > 0 ? map : undefined;
}
