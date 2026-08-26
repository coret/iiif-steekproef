/**
 * Een SPARQL SELECT uitvoeren tegen een endpoint.
 *
 * Waarom hier geen LDE: `@lde/pipeline`'s `SparqlItemSelector` is LDE's
 * SELECT-bouwsteen, maar die laat elke rij vallen waarin een geprojecteerde
 * variabele geen IRI is. Wij willen naast ?dataset ook tellingen — literals —
 * dus dan zou er niets overblijven. Voor het Dataset Register wordt LDE's
 * `@lde/dataset-registry-client` wél gebruikt; zie discover.ts.
 */
import { USER_AGENT } from './rdf.ts';

/** Eén rij: variabelenaam -> waarde. Ongebonden variabelen ontbreken. */
export type Bindings = Record<string, string>;

export async function sparqlSelect(
  endpoint: string,
  query: string,
  timeoutMs = 60_000,
): Promise<Bindings[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `SPARQL-query mislukt: HTTP ${response.status} ${response.statusText} — ${endpoint}\n` +
        (await response.text()).slice(0, 400),
    );
  }

  const body = (await response.json()) as {
    results?: { bindings?: Record<string, { value?: string }>[] };
  };
  return (body.results?.bindings ?? []).map((row) =>
    Object.fromEntries(
      Object.entries(row).flatMap(([name, term]) =>
        typeof term.value === 'string' ? [[name, term.value] as const] : [],
      ),
    ),
  );
}
