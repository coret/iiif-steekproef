/**
 * Publiceert naar de webmap: per dataset een IIIF Collection, een ledger van
 * alle datasets, en een daaruit opgebouwde index.html met een keuzelijst en een
 * Tify-viewer.
 *
 * `catalogs.json` is de bron van waarheid en `index.html` wordt élke run
 * volledig opnieuw gegenereerd. Dat is bewust: HTML-chirurgie op een bestaand
 * bestand is broos, terwijl hergenereren altijd hetzelfde resultaat geeft.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DKG_ENDPOINT } from './knowledge-graph.ts';
import type { Rejection } from './manifests.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CatalogEntry {
  uuid: string;
  created: string;
  datasetUrl: string;
  datasetName: string;
  datasetDescription?: string;
  publisher?: string;
  sampled: number;
  /** Wat de DKG als aantal IIIF-manifesten in de dataset opgeeft. */
  totalFound: number;
  /**
   * Het aantal manifest-IRI's dat de bron van deze dataset opleverde: uit de
   * DKG, of uit de distributie bij een workaround.
   */
  known: number;
  /** Waar de kandidaten vandaan kwamen; afwezig betekent `dkg`. */
  source?: 'dkg' | 'distributie';
  /** De manifesten die het niet haalden; leeg als alles laadde. */
  rejected?: Rejection[];
  /**
   * Of de browser het manifest en de beelden bij de bron mag ophalen.
   * `null` = niet vast te stellen (bron onbereikbaar of geen beeldservice).
   * `blockedAt` zegt wáár de redirect-keten strandde.
   */
  cors?: {
    manifests: boolean | null;
    images: boolean | null;
    blockedAt?: { host: string; status: number; hop: number };
  };
  /** Het eerste manifest in de collection; Tify opent hierop. */
  firstManifest?: string;
}

/**
 * Een dataset die niets opleverde. Zonder dit verdwijnt de meest sprekende
 * fout van de site: een dataset waarvan álle manifesten stuk zijn, staat
 * nergens meer — terwijl dat juist iets over die bron zegt.
 */
export interface DatasetFailure {
  datasetUrl: string;
  datasetName?: string;
  /** De melding zoals de run hem gaf. */
  reason: string;
  /**
   * Waar dit onder valt in het overzicht. De run weet dit zelf; ontbreekt het
   * (een ledger van vóór deze indeling), dan wordt het uit `reason` afgeleid.
   */
  category?: FailureCategory;
  /** Bij `laadt-niet`: de overheersende afkeurreden, bijv. `http-error`. */
  detail?: string;
}

export type FailureCategory = 'geen-manifest-iris' | 'laadt-niet' | 'overig';

/**
 * De submap waarin de collections staan. Eén plek, want de naam komt op drie
 * plaatsen terug: waar het bestand landt, wat er als `id` ín het bestand staat,
 * en waar de pagina naartoe wijst. Die drie moeten gelijk blijven.
 */
export const COLLECTIONS_DIR = 'manifests';

/** De publieke URL van een collection. */
export function collectionUrl(baseUrl: string, uuid: string): string {
  return `${baseUrl}/${COLLECTIONS_DIR}/${uuid}.json`;
}

export const THESEUS = 'https://theseusviewer.org/?iiif-content=';

export function theseusUrl(collectionUrl: string): string {
  return THESEUS + encodeURIComponent(collectionUrl);
}

/** De Tify-versie die de pagina van de CDN laadt. */
const TIFY_VERSION = '0.35.0';

/**
 * Het beeldmerk van bob.coret.org (`root/img/bc.png`), hier het merkteken in de
 * header. Daarnaast het favicon van diezelfde site: een .ico met meerdere
 * formaten erin, die browsers ook uit zichzelf op `/favicon.ico` opvragen.
 *
 * Beide worden bij elke publicatie meegekopieerd naar de webmap, zodat die map
 * op zichzelf compleet is en de pagina het logo ook laat zien als je het
 * bestand rechtstreeks opent.
 */
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
const LOGO = 'bc-logo.png';
const LOGO_SOURCE = resolve(ASSETS, LOGO);
const FAVICON = 'favicon.ico';
const FAVICON_SOURCE = resolve(ASSETS, FAVICON);

/**
 * Zonder deze header kan een viewer in de browser de collection niet ophalen.
 * De vhost zet hem ook, maar zo is de publicatiemap op zichzelf compleet — ook
 * als hij ooit ergens anders komt te staan.
 */
const HTACCESS = `# Beheerd door iiif-steekproef.
# IIIF-viewers (Tify, Theseus, Mirador, Clover) halen de collection op vanuit de
# browser en hebben daarvoor CORS nodig.
<IfModule mod_headers.c>
  <FilesMatch "\\.json$">
    Header set Access-Control-Allow-Origin "*"
  </FilesMatch>
</IfModule>
`;

/** De ledger van de vorige run; ontbreekt hij, dan beginnen we leeg. */
export async function readCatalogs(outputDir: string): Promise<CatalogEntry[]> {
  return readJsonArray<CatalogEntry>(join(outputDir, 'catalogs.json'));
}

/** De mislukte datasets van de vorige run; ontbreken ze, dan beginnen we leeg. */
export async function readFailures(outputDir: string): Promise<DatasetFailure[]> {
  return readJsonArray<DatasetFailure>(join(outputDir, 'failures.json'));
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Schrijft één collection weg. De bestandsnaam is stabiel per dataset. */
export async function writeCollection(
  outputDir: string,
  uuid: string,
  collection: Record<string, unknown>,
): Promise<string> {
  await mkdir(join(outputDir, COLLECTIONS_DIR), { recursive: true });
  const path = join(outputDir, COLLECTIONS_DIR, `${uuid}.json`);
  await writeFile(path, JSON.stringify(collection, null, 2) + '\n', 'utf8');
  return path;
}

/** Schrijft de ledgers, de index en de .htaccess. */
export async function publishSite(
  outputDir: string,
  baseUrl: string,
  entries: CatalogEntry[],
  failures: DatasetFailure[] = [],
): Promise<{ catalogsPath: string; indexPath: string }> {
  await mkdir(outputDir, { recursive: true });

  const catalogsPath = join(outputDir, 'catalogs.json');
  await writeFile(catalogsPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  // Aparte ledger: catalogs.json beschrijft wat er te bekijken valt, dit
  // beschrijft wat er niet te bekijken viel en waarom.
  await writeFile(
    join(outputDir, 'failures.json'),
    JSON.stringify(failures, null, 2) + '\n',
    'utf8',
  );

  const indexPath = join(outputDir, 'index.html');
  await writeFile(indexPath, renderIndex(entries, baseUrl, failures), 'utf8');

  await writeFile(join(outputDir, '.htaccess'), HTACCESS, 'utf8');

  await copyFile(LOGO_SOURCE, join(outputDir, LOGO));
  await copyFile(FAVICON_SOURCE, join(outputDir, FAVICON));

  return { catalogsPath, indexPath };
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const dutchDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso.slice(0, 10)
    : date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
};

const nl = (value: number): string => value.toLocaleString('nl-NL');

/**
 * De opmaak volgt de Digitaal Erfgoed Kijker (erfgoedkijker.coret.org): de
 * NDE-huisstijl uit `lab.coret.org/root/erfgoedkijker/tailwind.config.ts`,
 * Inter via rsms.me, een container van max-w-5xl, witte header- en footerbanden
 * op een lichtblauwe achtergrond, en witte kaarten met `shadow-card`.
 * Die site zet `color-scheme: light`, dus hier bewust ook geen dark mode.
 */
const STYLE = `
:root{
  --blue:#093ef5; --blue-dark:#0731c4; --blue-soft:#eaeefe;
  --ink:#0b1020; --muted:#5b6577; --line:#e3e7ef; --bg:#f6f8fc;
  --shadow-card:0 1px 2px rgba(11,16,32,.04),0 8px 24px rgba(11,16,32,.06);
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{padding:0;margin:0}
body{background:var(--bg);color:var(--ink);
  font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
@supports (font-variation-settings:normal){
  body{font-family:"Inter var",Inter,system-ui,sans-serif}
}
.wrap{max-width:64rem;margin-inline:auto;padding-inline:1.25rem}
a{color:inherit}

header.site,footer.site{background:#fff}
header.site{border-bottom:1px solid var(--line)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;
  gap:1rem;padding-block:2.5rem}
.brand{display:flex;align-items:center;gap:.75rem;text-decoration:none}
.brand .mark{height:2.5rem;width:auto;flex:none}
.brand .title{font-size:1.875rem;line-height:2.25rem;font-weight:700;
  letter-spacing:-.025em;color:var(--ink)}
.badges{display:flex;align-items:center;gap:.25rem;border:1px solid var(--line);
  background:#fff;border-radius:9999px;padding:.25rem}
.badges span{border-radius:9999px;padding:.25rem .625rem;font-size:.75rem;
  line-height:1rem;font-weight:600;color:var(--muted);white-space:nowrap}
.badges span.on{background:var(--blue);color:#fff}

main.site{max-width:64rem;margin-inline:auto;padding:2rem 1.25rem}
.stack>*+*{margin-top:2rem}
.lead{color:var(--muted);text-wrap:balance;margin:0}

label.pick{display:block;font-size:.875rem;font-weight:600;margin:0 0 .5rem}
select{width:100%;border:1px solid var(--line);background-color:#fff;color:var(--ink);
  border-radius:.75rem;padding:.75rem 2.75rem .75rem 1rem;font:inherit;font-size:1rem;
  box-shadow:0 1px 2px rgba(11,16,32,.04);outline:none;cursor:pointer;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235b6577' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 1rem center;background-size:1.1rem}
select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(9,62,245,.2)}

.details{margin-top:1rem;background:#fff;border:1px solid var(--line);
  border-radius:1rem;box-shadow:var(--shadow-card);padding:1.25rem}
.details h2{font-size:1.125rem;line-height:1.5rem;font-weight:600;
  letter-spacing:-.015em;margin:0}
.details .desc{margin:.5rem 0 0;color:var(--muted);text-wrap:balance;max-width:70ch}
.details .who{margin:.5rem 0 0;font-size:.875rem;color:var(--muted)}
.details dl{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;margin:.875rem 0 0;
  font-size:.875rem;font-variant-numeric:tabular-nums}
.details dl div{display:flex;gap:.375rem}
.details dl dt{color:var(--muted)}
.details dl dd{margin:0;font-weight:500}
.details code{font-size:.8125rem;background:var(--bg);border:1px solid var(--line);
  border-radius:.375rem;padding:0 .375rem;font-weight:400}

.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.25rem}
.warn{margin:.875rem 0 0;padding:.625rem .875rem;border:1px solid #f5d9a8;
  border-radius:.5rem;background:#fdf6e8;color:#7a5320;font-size:.8125rem;
  line-height:1.25rem;max-width:70ch}
.rejects{margin-top:1.25rem;border-top:1px solid var(--line);padding-top:.875rem}
.rejects h3{margin:0 0 .5rem;font-size:.875rem;line-height:1.25rem;font-weight:600;
  color:var(--muted)}
.rejects ul,.skipped ul{list-style:none;margin:0;padding:0;display:flex;
  flex-direction:column;gap:.375rem}
.rejects li,.skipped li{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;
  font-size:.8125rem;line-height:1.25rem}
.why{flex:none;border:1px solid var(--line);border-radius:9999px;padding:0 .5rem;
  background:var(--bg);font-weight:500}
.rejects a,.skipped a{color:var(--muted);text-decoration:none;word-break:break-all}
.rejects a:hover,.skipped a:hover{color:var(--blue);text-decoration:underline}
.skipped{margin-top:1rem;background:#fff;border:1px solid var(--line);
  border-radius:.75rem;padding:1rem 1.25rem}
.skipped summary{cursor:pointer;font-weight:600;font-size:.875rem}
.skipped h3{margin:1.125rem 0 .5rem;font-size:.8125rem;line-height:1.25rem;
  font-weight:600;color:var(--muted);text-transform:none}
.skipped h3:first-of-type{margin-top:.75rem}
.skipped p{margin:.5rem 0 .875rem;font-size:.8125rem;color:var(--muted);max-width:70ch}
.skipped .naam{font-weight:500;color:var(--ink)}
.skipped a.sparql{flex:none;border:1px solid var(--line);border-radius:9999px;
  padding:0 .5rem;background:var(--bg);color:var(--blue);font-weight:500;
  text-decoration:none;word-break:normal}
.skipped a.sparql:hover{border-color:var(--blue);text-decoration:none}
.btn{display:inline-flex;align-items:center;gap:.5rem;text-decoration:none;
  border-radius:.75rem;padding:.5rem .875rem;font-size:.875rem;font-weight:600;
  border:1px solid var(--line);background:#fff;color:var(--blue);
  box-shadow:0 1px 2px rgba(11,16,32,.04);
  transition:background-color .15s,border-color .15s,color .15s}
.btn:hover{border-color:var(--blue);background:var(--blue-soft)}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.btn.primary:hover{background:var(--blue-dark);border-color:var(--blue-dark);color:#fff}
.btn svg{width:1rem;height:1rem;stroke:currentColor;fill:none;stroke-width:1.75;flex:none}

/*
 * De viewer staat bewust buiten <main> en dus buiten de max-w-5xl-container:
 * over de volle vensterbreedte is er veel meer ruimte voor een scan. Als
 * broer-element in de gewone stroom hoeft er geen 100vw-truc aan te pas te
 * komen, die zich altijd verslikt in de breedte van de schuifbalk. Geen ronde
 * hoeken en zijranden, want die horen bij een kaart, niet bij een volle band.
 */
.viewer{width:100%;height:min(85vh,900px);background:#fff;
  border-block:1px solid var(--line);overflow:hidden}
.viewer .tify{height:100%;width:100%}

.placeholder{margin-top:1rem;border:1px dashed var(--line);background:#fff;
  border-radius:1rem;padding:3rem 2rem;text-align:center;color:var(--muted)}

[hidden]{display:none !important}

.empty{border:1px solid var(--line);background:#fff;border-radius:1rem;
  box-shadow:var(--shadow-card);padding:2rem;text-align:center;color:var(--muted)}

footer.site{border-top:1px solid var(--line)}
footer.site .wrap{padding-block:2.5rem;font-size:.875rem;line-height:1.25rem;
  color:var(--muted);text-wrap:balance}
footer.site a{color:var(--blue);text-decoration:none}
footer.site a:hover{text-decoration:underline}
`;

/**
 * Even hoog als op de ErfgoedKijker (h-10); de CSS bepaalt de hoogte, de
 * afmetingen hier houden alleen de verhouding vast. Het `alt`-attribuut is leeg
 * omdat de naam er in de titel ernaast al staat.
 */
const MARK = `<img class="mark" src="${LOGO}" alt="" width="256" height="256">`;

/**
 * De pagina draagt zijn eigen gegevens mee in een JSON-blok. Dat scheelt een
 * fetch, en de keuzelijst werkt daardoor ook als je het bestand direct opent.
 */
/**
 * Waarom een manifest het niet haalde, in gewone taal. De validator geeft een
 * grove code; bij een HTTP-fout is de status het enige dat echt iets zegt.
 */
function whyLabel(rejection: Rejection): string {
  if (rejection.reason === 'http-error') {
    return rejection.status === undefined ? 'HTTP-fout' : 'HTTP ' + rejection.status;
  }
  const labels: Record<string, string> = {
    timeout: 'time-out',
    'network-error': 'server onbereikbaar',
    'invalid-json': 'ongeldige JSON',
    'binary-content': 'geen manifest maar een mediabestand',
    'not-a-manifest': 'geen IIIF-manifest',
    'does-not-load': 'laadt niet in een viewer',
    'no-content': 'geen inhoud',
    'no-body': 'lege respons',
  };
  return labels[rejection.reason] ?? rejection.reason;
}

const YASGUI = 'https://yasgui.coret.org/';

/**
 * De datasetpagina in het NDE Dataset Register. In de foutenlijst is dat een
 * nuttiger bestemming dan de datasetbeschrijving zelf: die is vaak kale RDF,
 * terwijl het register laat zien wat er over de dataset bekend is.
 */
const DATASET_REGISTER = 'https://datasetregister.netwerkdigitaalerfgoed.nl/dataset?uri=';

/**
 * De reden zoals de run hem gaf, met de workaround-markering er weer af — die
 * krijgt zijn eigen pil, zodat hij opvalt tussen de foutmeldingen.
 */
const MARKERING = /\s\*\s(verwerkt via workaround|workaround mislukt.*)$/;

function kaal(reason: string): string {
  return reason.replace(MARKERING, '');
}

function markering(reason: string): string {
  const found = MARKERING.exec(reason);
  return found === null ? '' : ` <span class="why">${escape(found[1]!)}</span>`;
}

/**
 * De query die laat zien wat de DKG van deze dataset aan manifesten vastlegt.
 *
 * Dezelfde vorm als in `knowledge-graph.ts`, op één dataset toegespitst — ook
 * de `BIND` in plaats van een `FILTER` binnen een `OPTIONAL`, want dat laatste
 * bindt deze endpoint niet. Geen resultaten is hier een antwoord en geen fout:
 * dan kent de DKG er geen, en valt er dus niets te bemonsteren.
 */
function dkgQuery(datasetUrl: string): string {
  return `# De IIIF-manifesten die de NDE Dataset Knowledge Graph van deze dataset vastlegt.
# Geen resultaten? Dan kent de DKG er geen, en valt er niets te bemonsteren.
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX dct:  <http://purl.org/dc/terms/>
PREFIX prov: <http://www.w3.org/ns/prov#>

SELECT ?manifest WHERE {
  <${datasetUrl}> void:subset ?subset .
  ?subset dct:conformsTo <http://iiif.io/api/presentation/> .
  BIND(IRI(CONCAT(STR(?subset), "-validation-activity")) AS ?activity)
  ?activity prov:used ?manifest .
  FILTER(isIRI(?manifest)
         && ?manifest != <http://iiif.io/api/presentation/>
         && !STRSTARTS(STR(?subset), STR(?manifest)))
}`;
}

/** De query klaargezet in YASGUI, tegen de DKG. */
function yasguiUrl(datasetUrl: string, title: string): string {
  const parameters = {
    query: dkgQuery(datasetUrl),
    endpoint: DKG_ENDPOINT,
    requestMethod: 'POST',
    tabTitle: title.slice(0, 40),
    headers: '{}',
    contentTypeConstruct: 'text/turtle',
    contentTypeSelect: 'application/sparql-results+json',
    outputFormat: 'Table',
  };
  const hash = Object.entries(parameters)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `${YASGUI}#${hash}`;
}

/**
 * De datasets die niets opleverden, onder de keuzelijst. Dichtgeklapt, want het
 * zijn er meer dan er gelukt zijn — maar ze horen op de pagina: dat een bron
 * geen enkel werkend manifest heeft is een uitkomst, geen ruis.
 */
/**
 * Waaronder een mislukking valt. De run zet dit zelf in de ledger; voor een
 * ledger van vóór die indeling wordt het uit de melding afgeleid, zodat een
 * oude `failures.json` niet ineens één grote hoop 'overig' wordt.
 */
function categoryOf(failure: DatasetFailure): FailureCategory {
  if (failure.category !== undefined) return failure.category;
  // Ook "Het ...": zo heette de melding voordat het lidwoord werd gecorrigeerd.
  if (/^(De|Het) Dataset Knowledge Graph legt/.test(failure.reason)) return 'geen-manifest-iris';
  if (failure.reason.startsWith('Geen enkel manifest laadt')) return 'laadt-niet';
  return 'overig';
}

/**
 * Bij `laadt-niet` de overheersende afkeurreden, want dát is het eigenlijke
 * verschil tussen zulke datasets: een 404 is een andere kwaal dan een manifest
 * dat wel binnenkomt maar niet rendert.
 */
function detailOf(failure: DatasetFailure): string | undefined {
  if (categoryOf(failure) !== 'laadt-niet') return undefined;
  if (failure.detail !== undefined) return failure.detail;
  const counted = [...failure.reason.matchAll(/(\d+)x ([a-z-]+)/g)];
  if (counted.length === 0) return undefined;
  const dominant = counted.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return counted.length > 1 ? 'gemengd' : dominant![2];
}

const CATEGORY_LABELS: Record<FailureCategory, string> = {
  'geen-manifest-iris': "de Dataset Knowledge Graph legt geen manifest-IRI's vast",
  'laadt-niet': 'geen enkel manifest laadt',
  overig: 'anders mislukt',
};

const DETAIL_LABELS: Record<string, string> = {
  'http-error': 'HTTP-fout',
  'does-not-load': 'laadt niet in een viewer',
  timeout: 'time-out',
  'network-error': 'server onbereikbaar',
  'no-content': 'geen inhoud',
  'not-a-manifest': 'geen IIIF-manifest',
  'invalid-json': 'ongeldige JSON',
  gemengd: 'verschillende oorzaken',
};

function groupHeading(category: FailureCategory, detail: string | undefined): string {
  const base = CATEGORY_LABELS[category];
  if (detail === undefined) return base;
  return `${base} — ${DETAIL_LABELS[detail] ?? detail}`;
}

function renderSkipped(failures: DatasetFailure[]): string {
  if (failures.length === 0) return '';

  // Groeperen op categorie, en binnen 'laadt-niet' op de overheersende reden.
  const groups = new Map<string, { heading: string; failures: DatasetFailure[] }>();
  for (const failure of failures) {
    const category = categoryOf(failure);
    const detail = detailOf(failure);
    const key = `${category}|${detail ?? ''}`;
    const group = groups.get(key) ?? { heading: groupHeading(category, detail), failures: [] };
    group.failures.push(failure);
    groups.set(key, group);
  }

  const blocks = [...groups.values()]
    .sort((a, b) => b.failures.length - a.failures.length)
    .map((group) => {
      const items = group.failures.map((failure) => renderFailure(failure, group)).join('\n');
      return `      <h3>${nl(group.failures.length)} ${
        group.failures.length === 1 ? 'dataset' : 'datasets'
      }: ${escape(group.heading)}</h3>
      <ul>
${items}
      </ul>`;
    })
    .join('\n');

  return `  <section>
    <details class="skipped">
      <summary>${nl(failures.length)} ${
        failures.length === 1 ? 'dataset' : 'datasets'
      } zonder bruikbare steekproef</summary>
      <p>
        Van deze datasets legt de Dataset Knowledge Graph geen manifesten vast, of laadde
        geen enkel manifest dat het wél kent. Per soort probleem bij elkaar gezet.
      </p>
${blocks}
    </details>
  </section>`;
}

/**
 * Eén regel. De melding wordt weggelaten als de kop hem al zegt — dat scheelt
 * bij de grootste groep 51 keer dezelfde zin.
 */
function renderFailure(
  failure: DatasetFailure,
  group: { failures: DatasetFailure[] },
): string {
  const name = failure.datasetName ?? failure.datasetUrl;
  const reason = kaal(failure.reason);
  const zegtDeKopHetAl = group.failures.every((other) => kaal(other.reason) === reason);
  return (
    '        <li><a class="naam" href="' +
    escape(DATASET_REGISTER + encodeURIComponent(failure.datasetUrl)) +
    // Vast venster: wie een rij afgaat houdt zo één registertabblad in plaats
    // van er twintig te openen.
    '" target="datasetregister" rel="noreferrer">' +
    escape(name) +
    '</a>' +
    (zegtDeKopHetAl ? '' : ' <span>' + escape(reason) + '</span>') +
    markering(failure.reason) +
    ' <a class="sparql" href="' +
    escape(yasguiUrl(failure.datasetUrl, name)) +
    '" target="_blank" rel="noreferrer">SPARQL</a></li>'
  );
}

/**
 * Wat er over CORS te melden valt, in gewone taal. Server-side opgebouwd zodat
 * de pagina alleen nog hoeft te tonen — en zodat de host en de stap uit de
 * meting komen en niet uit een aanname.
 */
/**
 * Waar de steekproef vandaan komt. Twee routes, twee verhalen: normaal de
 * manifesten die de DKG vastlegt, en bij een workaround de dump zelf.
 */
function herkomst(entry: CatalogEntry): string {
  return entry.source === 'distributie'
    ? `${nl(entry.known)} manifesten in de RDF-distributie (workaround)`
    : `${nl(entry.known)} manifesten vastgelegd in de NDE Dataset Knowledge Graph`;
}

function corsNotes(entry: CatalogEntry): string[] {
  const cors = entry.cors;
  if (!cors) return [];
  const notes: string[] = [];
  const where = cors.blockedAt;

  if (cors.manifests === false) {
    notes.push(
      where && where.hop > 1
        ? `De manifest-IRI's van deze bron lopen via een redirect-keten waarvan stap ${where.hop} ` +
            `(${where.host}, HTTP ${where.status}) geen Access-Control-Allow-Origin stuurt. Een browser ` +
            'weigert dan het hele verzoek, ook al is het eindadres wél in orde — je ziet hier dus geen beeld.'
        : 'De bron geeft de manifesten niet vrij voor de browser (geen Access-Control-Allow-Origin), ' +
            'dus de viewer kan ze niet laden.',
    );
  }
  if (cors.images === false) {
    notes.push(
      'De beeldserver van deze bron geeft info.json niet vrij voor de browser, dus de afbeeldingen ' +
        'blijven leeg.',
    );
  }
  return notes;
}

function renderIndex(
  entries: CatalogEntry[],
  baseUrl: string,
  failures: DatasetFailure[] = [],
): string {
  const manifests = entries.reduce((sum, entry) => sum + entry.sampled, 0);

  const data = entries.map((entry) => ({
    uuid: entry.uuid,
    name: entry.datasetName,
    description: entry.datasetDescription ?? null,
    publisher: entry.publisher ?? null,
    created: dutchDate(entry.created),
    sampled: nl(entry.sampled),
    totalFound: nl(entry.totalFound),
    datasetUrl: entry.datasetUrl,
    herkomst: herkomst(entry),
    collectionUrl: collectionUrl(baseUrl, entry.uuid),
    firstManifest: entry.firstManifest ?? null,
    rejected: (entry.rejected ?? []).map((rejection) => ({
      uri: rejection.uri,
      why: whyLabel(rejection),
    })),
    cors: corsNotes(entry),
  }));

  const options = entries
    .map((entry) => `        <option value="${escape(entry.uuid)}">${escape(entry.datasetName)}</option>`)
    .join('\n');

  const picker =
    entries.length === 0
      ? '    <section><p class="empty">Nog geen datasets bemonsterd.</p></section>'
      : `    <section>
      <label class="pick" for="dataset">Dataset</label>
      <select id="dataset">
        <option value="">Kies een dataset</option>
${options}
      </select>

      <div class="details" id="details" hidden>
        <h2 id="d-name"></h2>
        <p class="desc" id="d-description" hidden></p>
        <p class="who" id="d-publisher"></p>
        <dl>
          <div><dt>Steekproef</dt><dd id="d-sample"></dd></div>
          <div><dt>Gecontroleerd</dt><dd id="d-created"></dd></div>
          <div><dt>Herkomst</dt><dd id="d-source"></dd></div>
        </dl>

        <p class="warn" id="d-cors" hidden></p>
        <div class="actions">
          <a class="btn" id="d-dataset" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h7l4 4v14H8z"/><path d="M15 3v4h4"/></svg>
            Datasetbeschrijving
          </a>
          <a class="btn" id="d-collection">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
            IIIF Collection (JSON)
          </a>
        </div>

        <div class="rejects" id="d-rejects" hidden>
          <h3 id="d-rejects-title"></h3>
          <ul id="d-reject-list"></ul>
        </div>
      </div>

      <p class="placeholder" id="placeholder">
        Kies hierboven een dataset om de steekproef door te bladeren.
      </p>
    </section>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IIIF Steekproef</title>
<meta name="description" content="Willekeurige steekproeven van IIIF-manifesten uit erfgoeddatasets, gepubliceerd als IIIF Presentation 3 Collections.">
<link rel="icon" href="${FAVICON}" sizes="any">
<link rel="apple-touch-icon" href="${LOGO}">
<link rel="preconnect" href="https://rsms.me" crossorigin="anonymous">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tify@${TIFY_VERSION}/dist/tify.css">
<style>${STYLE}</style>
</head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="/">
    ${MARK}
    <span class="title">IIIF Steekproef</span>
  </a>
  <div class="badges" role="group" aria-label="Overzicht">
    <span class="on">${nl(entries.length)} ${entries.length === 1 ? 'dataset' : 'datasets'}</span>
    <span>${nl(manifests)} manifesten</span>
  </div>
</div></header>

<main class="site stack">
  <section>
    <p class="lead">
      De IIIF-manifesten die de NDE Dataset Knowledge Graph van een erfgoeddataset kent,
      gebundeld als IIIF Presentation 3 Collection. Elk manifest is vooraf gecontroleerd op
      of het daadwerkelijk laadt; wat afvalt staat er met reden bij.
      Kies een dataset om de steekproef door te bladeren.
    </p>
  </section>

${picker}
${renderSkipped(failures)}
</main>

<div class="viewer" id="viewer" hidden><div class="tify" id="tify"></div></div>

<footer class="site"><div class="wrap">
  Prototype dat een steekproef IIIF-manifesten uit een erfgoeddataset als
  <a href="https://iiif.io/api/presentation/3.0/" target="_blank" rel="noreferrer">IIIF Presentation 3</a>
  Collection publiceert, gebouwd op
  <a href="https://ldelements.org/" target="_blank" rel="noreferrer">LD Elements</a>,
  met datasetbeschrijvingen volgens het
  <a href="https://datasetregister.netwerkdigitaalerfgoed.nl/" target="_blank" rel="noreferrer">NDE Dataset Register</a>,
  en weergave via <a href="https://tify.rocks/" target="_blank" rel="noreferrer">TIFY</a>.
  Broncode op
  <a href="https://github.com/coret/iiif-steekproef" target="_blank" rel="noreferrer">GitHub</a>.
</div></footer>

<script type="application/json" id="catalogs">${jsonForScript(data)}</script>
<script type="module">
import Tify from 'https://cdn.jsdelivr.net/npm/tify@${TIFY_VERSION}/dist/tify.js';

const catalogs = JSON.parse(document.getElementById('catalogs').textContent);
const byUuid = new Map(catalogs.map((entry) => [entry.uuid, entry]));

const select = document.getElementById('dataset');
const details = document.getElementById('details');
const placeholder = document.getElementById('placeholder');
const viewer = document.getElementById('viewer');
const mount = document.getElementById('tify');

let tify;

const TIFY_QUERY_KEY = 'tify';

/**
 * Zet Tify's beginstand in de URL. Tify leest die bij het opstarten en houdt
 * hem daarna zelf bij, dus pagina en zoomniveau blijven deelbaar.
 */
function setTifyState(state) {
  const url = new URL(window.location.href);
  if (state) url.searchParams.set(TIFY_QUERY_KEY, JSON.stringify(state));
  else url.searchParams.delete(TIFY_QUERY_KEY);
  window.history.replaceState(null, '', url);
}

const set = (id, text) => { document.getElementById(id).textContent = text; };
const link = (id, href) => { document.getElementById(id).href = href; };

/** Tify bouwt zijn eigen DOM in de container; zonder opruimen stapelen ze op. */
function teardown() {
  if (!tify) return;
  try { tify.destroy(); } catch (error) { /* al opgeruimd */ }
  tify = undefined;
  mount.innerHTML = '';
}

/**
 * CORS is het enige dat de sampler niet zelf kan ondervinden: die haalt alles
 * met Node op, en Node houdt zich niet aan CORS. Staat het manifest of de
 * beeldserver de browser niet toe, dan blijft de viewer hieronder leeg zonder
 * dat er iets mis is met het manifest — dus zeggen we dat er hier bij.
 */
function showCors(notes) {
  const note = document.getElementById('d-cors');
  note.textContent = (notes || []).join(' ');
  note.hidden = !notes || notes.length === 0;
}

/** De manifesten die het niet haalden, met de reden erbij. */
function showRejects(items) {
  const block = document.getElementById('d-rejects');
  const list = document.getElementById('d-reject-list');
  list.innerHTML = '';
  block.hidden = items.length === 0;
  if (items.length === 0) return;
  set('d-rejects-title', items.length === 1
    ? '1 manifest niet opgenomen'
    : items.length + ' manifesten niet opgenomen');
  for (const item of items) {
    const row = document.createElement('li');
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = item.why;
    const link = document.createElement('a');
    link.href = item.uri;
    link.textContent = item.uri;
    link.target = '_blank';
    link.rel = 'noreferrer';
    row.append(why, link);
    list.append(row);
  }
}

function show(entry) {
  set('d-name', entry.name);
  // Niet elke dataset beschrijft zichzelf; dan geen lege regel tonen.
  const description = document.getElementById('d-description');
  description.textContent = entry.description ?? '';
  description.hidden = !entry.description;
  set('d-publisher', entry.publisher ?? 'Onbekende bronhouder');
  set('d-sample', entry.sampled + ' van ' + entry.totalFound + ' manifesten');
  set('d-created', entry.created);
  set('d-source', entry.herkomst);
  showCors(entry.cors);
  showRejects(entry.rejected || []);
  link('d-dataset', entry.datasetUrl);
  link('d-collection', entry.collectionUrl);

  details.hidden = false;
  placeholder.hidden = true;
  viewer.hidden = false;

  teardown();
  // Tify moet twee dingen tegelijk doen: het eerste manifest tonen, en het
  // collectiepaneel open hebben staan.
  //
  // Het manifest gaat via de URL-status. Tify's eigen autoload doet hier niets:
  // die leest collection.manifests, de Presentation 2-vorm, terwijl een
  // v3-Collection items heeft. De constructor-optie childManifestUrl wordt bij
  // het opstarten evenmin gelezen; alleen de URL-status wel.
  //
  // Het paneel gaat via de constructor. Zodra Tify een startmanifest heeft,
  // laat het view ongemoeid, dus wat hier staat blijft staan.
  //
  // Een bestaande URL-status wint: kwam de bezoeker binnen via een gedeelde
  // link naar een bepaald manifest of paginanummer, dan blijft die behouden.
  if (!currentTifyState()) {
    setTifyState(entry.firstManifest ? { childManifestUrl: entry.firstManifest } : null);
  }
  tify = new Tify({
    container: mount,
    manifestUrl: entry.collectionUrl,
    language: 'nl',
    view: 'collection',
    urlQueryKey: TIFY_QUERY_KEY,
  });
}

/** De Tify-status die al in de URL staat, of niets. */
function currentTifyState() {
  return new URLSearchParams(window.location.search).get(TIFY_QUERY_KEY);
}

function clear() {
  details.hidden = true;
  viewer.hidden = true;
  placeholder.hidden = false;
  teardown();
  setTifyState(null);
}

select.addEventListener('change', () => {
  const entry = byUuid.get(select.value);
  // De keuze in de URL zetten, zodat je een dataset kunt delen. De achtergebleven
  // Tify-status van de vorige dataset moet weg: die wijst naar een manifest dat
  // niet in deze collection zit.
  setTifyState(null);
  const url = new URL(window.location.href);
  if (entry) url.searchParams.set('dataset', entry.uuid);
  else url.searchParams.delete('dataset');
  window.history.replaceState(null, '', url);
  if (entry) show(entry); else clear();
});

// Diepe link: ?dataset=<uuid> opent die dataset meteen.
const wanted = new URLSearchParams(window.location.search).get('dataset');
if (wanted && byUuid.has(wanted)) {
  select.value = wanted;
  show(byUuid.get(wanted));
}
</script>
</body>
</html>
`;
}

/**
 * JSON in een `<script>` mag geen `</script>` bevatten, en `<!--` zou de rest
 * van de pagina een commentaar in trekken.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
