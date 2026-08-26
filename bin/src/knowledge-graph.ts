/**
 * De IIIF-manifesten die het NDE Dataset Knowledge Graph van een dataset kent.
 *
 * NDE valideert per dataset een steekproef IIIF-manifesten met SHACL en legt
 * met PROV vast wélke manifesten daarbij zijn opgehaald. Precies díe IRI's
 * halen we hier op: dat scheelt het downloaden en parsen van de RDF-dump, die
 * voor de grootste datasets vele gigabytes is.
 *
 * Wat je ervoor terugkrijgt is wel NDE's steekproef en niet die van jezelf:
 * hoogstens tien manifesten per dataset, en elke run dezelfde tien.
 */
import { sparqlSelect } from './sparql.ts';

export const DKG_ENDPOINT =
  'https://sparql.netwerkdigitaalerfgoed.nl/dataset-knowledge-graph';

export interface KnownManifests {
  /** Het aantal IIIF-manifesten dat het DKG aan de dataset toeschrijft. */
  total: number;
  /** De manifest-IRI's die NDE's validatie daadwerkelijk heeft gebruikt. */
  manifests: string[];
}

/**
 * De vorm waarin het DKG dit vastlegt:
 *
 *   <dataset>            void:subset      <subset> .
 *   <subset>             dct:conformsTo   <http://iiif.io/api/presentation/> ;
 *                        void:entities    <aantal> .
 *   <subset>-validation-activity  prov:used  <manifest> .
 *
 * Drie dingen zijn hier niet vanzelfsprekend:
 *
 * 1. De activiteit heet naar de *subset*, niet naar de dataset. Bij een dataset
 *    met een persistente identifier (`n2t.net/ark:/...`) is de dataset-IRI niet
 *    de basis van het void-document, dus een `STRSTARTS` op de dataset-IRI
 *    levert daar niets op. Op de subset-IRI werkt het overal.
 * 2. Dat verband moet met `BIND` gelegd worden en niet met een `FILTER` binnen
 *    een `OPTIONAL`: een filter dat daarbinnen naar een variabele van buiten
 *    verwijst, bindt deze endpoint niet — je krijgt dan stilletjes nul rijen.
 * 3. `prov:used` bevat naast de manifesten ook het profiel waartegen is
 *    gevalideerd en de dataset zelf. Het profiel filteren we op naam; de
 *    dataset herken je eraan dat de subset-IRI ermee begint.
 */
const QUERY = `
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX dct:  <http://purl.org/dc/terms/>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?dataset ?entities ?manifest WHERE {
  ?dataset void:subset ?subset .
  ?subset dct:conformsTo <http://iiif.io/api/presentation/> ;
          void:entities ?entities .
  FILTER(!CONTAINS(STR(?dataset), "/.well-known/void"))
  BIND(IRI(CONCAT(STR(?subset), "-validation-activity")) AS ?activity)
  ?activity prov:used ?manifest .
  FILTER(isIRI(?manifest)
         && ?manifest != <http://iiif.io/api/presentation/>
         && !STRSTARTS(STR(?subset), STR(?manifest)))
}
ORDER BY ?dataset ?manifest`;

/**
 * Alles in één keer ophalen: het zijn een paar honderd rijen, en per dataset
 * een aparte query zou het endpoint zonder reden 135 keer bevragen.
 */
export async function fetchKnownManifests(
  endpoint: string = DKG_ENDPOINT,
): Promise<Map<string, KnownManifests>> {
  const known = new Map<string, KnownManifests>();
  for (const row of await sparqlSelect(endpoint, QUERY)) {
    const dataset = row['dataset'];
    const manifest = row['manifest'];
    if (!dataset || !manifest) continue;
    const entry = known.get(dataset) ?? { total: Number(row['entities']) || 0, manifests: [] };
    // Een manifest kan via meerdere usages zijn vastgelegd.
    if (!entry.manifests.includes(manifest)) entry.manifests.push(manifest);
    known.set(dataset, entry);
  }
  return known;
}
