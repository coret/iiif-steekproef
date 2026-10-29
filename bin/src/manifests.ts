/**
 * Trekt een steekproef uit de manifest-IRI's die de Dataset Knowledge Graph
 * van een dataset kent, en houdt alleen de manifesten over die écht laden.
 */
import { validateManifest } from '@lde/iiif-validator';
import { upgrade } from '@iiif/parser/upgrader';
import { USER_AGENT, type LangMap } from './rdf.ts';

/* ------------------------------------------------------------------ */
/* Steekproef                                                          */
/* ------------------------------------------------------------------ */

/**
 * Deterministische PRNG (mulberry32), zodat `--seed` een steekproef exact
 * reproduceerbaar maakt. `Math.random()` kent geen seed.
 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, op een kopie. */
export function shuffle<T>(items: T[], random: () => number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

/* ------------------------------------------------------------------ */
/* Validatie en verrijking                                             */
/* ------------------------------------------------------------------ */

/**
 * Waar een verzoek in een redirect-keten door de browser wordt tegengehouden.
 */
export interface BrowserAccess {
  /** Of een browser dit verzoek zou mogen doen; `null` = niet vast te stellen. */
  ok: boolean | null;
  /** De response die de browser weigerde. */
  blockedAt?: { url: string; status: number; hop: number };
}

const MAX_HOPS = 10;

/**
 * Of een browser dit zou mogen ophalen — de hele keten, niet alleen het einde.
 *
 * Node's fetch trekt zich niets van CORS aan en volgt redirects stilzwijgend,
 * dus wie alleen naar de laatste response kijkt ziet precies de hop die wél
 * goed is. Een browser controleert élke response in de keten; één tussenstap
 * zonder `Access-Control-Allow-Origin` laat het hele verzoek falen, ook als het
 * eindadres in orde is.
 *
 * Daarom lopen we de keten hier zelf af, met twee regels die het verschil
 * maken:
 *
 * 1. `redirect: 'manual'` — in Node levert dat de echte 3xx-response mét
 *    headers op (in een browser zou die ondoorzichtig zijn).
 * 2. Zodra een redirect van origin wisselt, wordt de origin ondoorzichtig en
 *    stuurt de browser `Origin: null`. Een server die de origin terugkaatst
 *    helpt vanaf dat punt dus niet meer; alleen `*` (of letterlijk `null`)
 *    komt er nog doorheen.
 */
export async function browserCanFetch(url: string, origin: string): Promise<BrowserAccess> {
  let current = url;
  let sent = origin;

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        headers: { origin: sent, accept: '*/*', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Onbereikbaar is iets anders dan geweigerd; daar doet dit geen uitspraak
      // over.
      return { ok: null };
    }

    if (!allows(response.headers.get('access-control-allow-origin'), sent)) {
      return { ok: false, blockedAt: { url: current, status: response.status, hop } };
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      const next = new URL(location, current);
      if (next.origin !== new URL(current).origin) sent = 'null';
      current = next.toString();
      continue;
    }

    return { ok: true };
  }

  return { ok: false, blockedAt: { url: current, status: 0, hop: MAX_HOPS } };
}

/** `*` mag altijd, verder alleen precies de origin die is meegestuurd. */
function allows(header: string | null, origin: string): boolean {
  return header === '*' || header === origin;
}

export interface ManifestEntry {
  /** Het canonieke `id` uit het manifest zelf. */
  id: string;
  /** De URI zoals die in de RDF stond — kan afwijken van `id`. */
  sourceUri: string;
  label: LangMap;
  thumbnail?: { id: string; type: 'Image'; format?: string }[];
  summary?: LangMap;
  homepage?: { id: string; type: string; format?: string }[];
  /** De IIIF Image API-service van het eerste canvas, om apart te toetsen. */
  imageService?: string;
}

/**
 * Een manifest dat het niet haalde. Dit is geen bijvangst maar uitkomst: bij
 * een steekproef van hoogstens tien zegt een kapot manifest evenveel over de
 * dataset als een werkend manifest, dus wordt het bewaard en getoond.
 */
export interface Rejection {
  /** De manifest-IRI zoals de DKG die kent. */
  uri: string;
  /** Grove reden, van de validator of van onze eigen inhoudscontrole. */
  reason: string;
  /** De HTTP-status, als de server er een gaf. */
  status?: number;
  /** Wat de server er zelf bij zei, bij `not-public`: de melding uit de JSON. */
  message?: string;
}

export interface SampleResult {
  entries: ManifestEntry[];
  attempted: number;
  /** Op volgorde van trekking, net als `entries`. */
  rejections: Rejection[];
}

/**
 * De reden die het vaakst voorkwam, of `gemengd` als er geen duidelijke is.
 * Dit is wat een dataset in het overzicht onder de juiste noemer brengt.
 */
export function dominantReason(rejections: Rejection[]): string | undefined {
  if (rejections.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const rejection of rejections) {
    counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
  }
  if (counts.size > 1) return 'gemengd';
  return [...counts.keys()][0];
}

/** Reden -> aantal, voor een regel in het log. */
export function summarize(rejections: Rejection[]): string {
  const counts = new Map<string, number>();
  for (const rejection of rejections) {
    // De status zegt alleen iets als de HTTP-laag het probleem wás; bij een
    // manifest dat netjes met 200 binnenkomt maar niet laadt, is hij ruis.
    const key =
      rejection.reason === 'http-error' && rejection.status !== undefined
        ? `${rejection.reason} ${rejection.status}`
        : rejection.reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([reason, times]) => `${times}x ${reason}`).join(', ');
}

/**
 * Loopt de geschudde kandidaten af tot er `count` manifesten zijn die laden.
 *
 * `validateManifest` doet meer dan een HTTP-check: het draait `@iiif/parser`'s
 * `upgrade()` + `normalize()` — precies de laadroute van Theseus, Mirador en
 * Clover. Een manifest dat daar struikelt, komt dus niet in de collection.
 */
export async function sampleManifests(
  candidates: string[],
  count: number,
  maxAttempts: number,
  concurrency: number,
  onResult: (uri: string, ok: boolean, reason: string) => void,
): Promise<SampleResult> {
  // Op volgorde van trekking, niet van voltooiing: de workers draaien parallel,
  // dus zonder deze index zou dezelfde --seed wel dezelfde manifesten opleveren
  // maar in een wisselende volgorde, en dus een ander bestand.
  const accepted: { order: number; entry: ManifestEntry }[] = [];
  const refused: { order: number; rejection: Rejection }[] = [];
  let next = 0;
  let attempted = 0;
  let inFlight = 0;

  const worker = async (): Promise<void> => {
    // `inFlight` telt mee in de stopvoorwaarde: zonder die reservering halen
    // vijf workers tot vier manifesten te veel op bij een server die niet van
    // ons is, om ze daarna weg te gooien.
    while (
      accepted.length + inFlight < count &&
      next < candidates.length &&
      attempted < maxAttempts
    ) {
      const order = next++;
      const uri = candidates[order];
      if (!uri) break;
      attempted++;
      inFlight++;
      try {
        const { entry, reason, status, message } = await inspect(uri);
        onResult(uri, entry !== undefined, reason);
        if (entry) accepted.push({ order, entry });
        else {
          refused.push({
            order,
            rejection: {
              uri,
              reason,
              ...(status === undefined ? {} : { status }),
              ...(message === undefined ? {} : { message }),
            },
          });
        }
      } finally {
        inFlight--;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );

  accepted.sort((a, b) => a.order - b.order);
  refused.sort((a, b) => a.order - b.order);
  return {
    entries: accepted.map((item) => item.entry),
    attempted,
    rejections: refused.map((item) => item.rejection),
  };
}

/**
 * Wat er achter een 403 zit. Twee gevallen die niets met elkaar te maken
 * hebben kregen anders hetzelfde label:
 *
 * - `bot-challenge`: een Cloudflare managed challenge. De server stuurt een
 *   HTML-pagina "Just a moment..." met `cf-mitigated: challenge`; geen enkele
 *   niet-browser komt erdoorheen, dus ook geen viewer of harvester.
 * - `not-public`: de applicatie zelf weigert het document. Atlantis zegt dan
 *   in JSON waarom: "The document is not publicly available", "The document
 *   is not moderated", "Access to this image is forbidden". NDE heeft de IRI
 *   ooit kunnen valideren, maar het document is nu niet (meer) openbaar.
 *
 * Elke andere status blijft een gewone `http-error`.
 */
interface Refusal {
  reason: 'bot-challenge' | 'not-public';
  message?: string;
}

export function classifyRefusal(response: Response, body: string): Refusal | undefined {
  if (response.status !== 403) return undefined;
  if (response.headers.get('cf-mitigated') === 'challenge') return { reason: 'bot-challenge' };
  const message = serverMessage(body);
  return message === undefined ? { reason: 'not-public' } : { reason: 'not-public', message };
}

/** De melding uit een JSON-body als `{"Message": "..."}`, zoals Atlantis die geeft. */
function serverMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const message = (parsed as Record<string, unknown>)['Message'] ?? (parsed as Record<string, unknown>)['message'];
    return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function inspect(
  uri: string,
): Promise<{ entry?: ManifestEntry; reason: string; status?: number; message?: string }> {
  const bodies = new Map<string, string>();
  // De validator meldt alleen `http-error`; de status zelf komt uitsluitend
  // hier langs, en juist die maakt een 404 (weg) van een 503 (nu even niet)
  // te onderscheiden.
  let status: number | undefined;
  let refusal: Refusal | undefined;
  const cachingFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('user-agent', USER_AGENT);
    const response = await fetch(input, { ...init, headers });
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if (url === uri) status = response.status;
    if (!response.ok) {
      if (url !== uri) return response;
      // Een 403 is zelden zomaar een 403: de body en de headers zeggen wie er
      // weigert. Eenmaal lezen en een verse kopie teruggeven.
      const text = await response.text();
      refusal = classifyRefusal(response, text);
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    // Body eenmaal lezen en bewaren, en een verse kopie teruggeven — zo hoeven
    // we het manifest niet nog een keer op te halen voor label en thumbnail.
    const text = await response.text();
    bodies.set(String(typeof input === 'string' ? input : (input as Request).url ?? input), text);
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const verdict = await validateManifest(uri, { fetch: cachingFetch, timeoutMs: 15_000 });
  const seen = status === undefined ? {} : { status };
  if (!verdict.valid) {
    if (verdict.reason === 'http-error' && refusal !== undefined) {
      return { reason: refusal.reason, ...seen, ...(refusal.message === undefined ? {} : { message: refusal.message }) };
    }
    return { reason: verdict.reason, ...seen };
  }

  const body = bodies.get(uri) ?? [...bodies.values()][0];
  if (!body) return { reason: 'no-body', ...seen };

  let manifest: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(body);
    // upgrade() tilt een v2-manifest naar v3 en laat v3 ongemoeid, zodat we
    // hieronder maar één vorm hoeven te kennen.
    manifest = (upgrade(raw) ?? raw) as Record<string, unknown>;
  } catch {
    return { reason: 'invalid-json', ...seen };
  }

  // Een manifest zonder canvas komt door de validatie heen — normalize() heeft
  // er geen moeite mee — maar valt in een viewer leeg open. Dat is voor wie de
  // steekproef bekijkt net zo goed een fout, dus behandelen we het ook zo.
  const items = manifest['items'];
  if (!Array.isArray(items) || items.length === 0) return { reason: 'no-content', ...seen };

  const entry = toEntry(uri, manifest);
  const service = imageServiceOf(manifest);
  if (service !== undefined) entry.imageService = service;
  return { entry, reason: verdict.reason, ...seen };
}

/**
 * De Image API-service van het eerste canvas. Die haalt de viewer apart op
 * (`info.json`), dus die heeft zijn eigen CORS-antwoord — een bron kan het
 * manifest wél vrijgeven en de beelden niet.
 */
function imageServiceOf(manifest: Record<string, unknown>): string | undefined {
  const body = firstRecord(
    firstRecord(firstRecord(manifest['items'])?.['items'])?.['items'],
  )?.['body'] as Record<string, unknown> | undefined;
  const service = body?.['service'];
  const first = Array.isArray(service) ? service[0] : service;
  if (!first || typeof first !== 'object') return undefined;
  const id = (first as Record<string, unknown>)['id'] ?? (first as Record<string, unknown>)['@id'];
  return typeof id === 'string' ? id.replace(/\/+$/, '') : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const first = Array.isArray(value) ? value[0] : undefined;
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
}

/** `manifest` is al door upgrade() heen, dus altijd in de v3-vorm. */
function toEntry(sourceUri: string, manifest: Record<string, unknown>): ManifestEntry {
  return {
    id: typeof manifest['id'] === 'string' ? manifest['id'] : sourceUri,
    sourceUri,
    label: normalizeLangMap(manifest['label']) ?? { none: [sourceUri] },
    thumbnail: normalizeThumbnail(manifest['thumbnail']),
    summary: normalizeLangMap(manifest['summary']),
    homepage: normalizeLinks(manifest['homepage']),
  };
}

/** IIIF v3 taalmap, defensief: v2 laat hier ook strings en objecten achter. */
function normalizeLangMap(value: unknown): LangMap | undefined {
  if (typeof value === 'string') return { none: [value] };
  if (!value || typeof value !== 'object') return undefined;
  const map: LangMap = {};
  for (const [language, values] of Object.entries(value as Record<string, unknown>)) {
    const list = (Array.isArray(values) ? values : [values])
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (list.length > 0) map[language] = list;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function normalizeThumbnail(value: unknown): ManifestEntry['thumbnail'] {
  const items = (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (typeof item === 'string') return { id: item, type: 'Image' as const };
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const id = record['id'] ?? record['@id'];
      if (typeof id !== 'string') return undefined;
      const format = typeof record['format'] === 'string' ? record['format'] : undefined;
      return { id, type: 'Image' as const, ...(format ? { format } : {}) };
    })
    .filter((item): item is { id: string; type: 'Image'; format?: string } => item !== undefined);
  return items.length > 0 ? items : undefined;
}

function normalizeLinks(value: unknown): ManifestEntry['homepage'] {
  const items = (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const id = record['id'] ?? record['@id'];
      if (typeof id !== 'string') return undefined;
      return {
        id,
        type: typeof record['type'] === 'string' ? record['type'] : 'Text',
        ...(typeof record['format'] === 'string' ? { format: record['format'] } : {}),
      };
    })
    .filter((item): item is { id: string; type: string; format?: string } => item !== undefined);
  return items.length > 0 ? items : undefined;
}
