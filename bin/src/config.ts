/**
 * Het configuratiebestand: één dataset-URI per regel.
 *
 * Lege regels en regels die met `#` beginnen worden overgeslagen, zodat je
 * datasets tijdelijk kunt uitzetten en er commentaar bij kunt schrijven.
 */
import { readFile } from 'node:fs/promises';

/** De actieve URI op een regel, of niets bij een lege regel of commentaar. */
function uriOnLine(line: string): string | undefined {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#') ? undefined : trimmed;
}

/**
 * De URI op een regel, óók als die is uitgecommentarieerd.
 *
 * Een uitgezette dataset is een genomen besluit. Zou `discover.ts` alleen naar
 * actieve regels kijken, dan zette de eerstvolgende zoekronde hem er gewoon
 * weer bij — en was uitcommentariëren zinloos.
 *
 * Alleen een commentaarregel die verder niets dan een URI bevat telt mee, zodat
 * een gewone aantekening waarin toevallig een link staat niet meetelt.
 */
function knownUriOnLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  const bare = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(bare) ? bare : undefined;
}

/**
 * De datasetlijst voor de sampler: streng. Een ongeldige URI of een leeg bestand
 * is een fout, want dan valt er niets te bemonsteren en wil je dat weten.
 */
export async function readDatasetList(path: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `Configuratiebestand niet gevonden: ${path}\n` +
        'Zet er één dataset-URI per regel in, geef een URI mee op de opdrachtregel, ' +
        'of vul het bestand met src/discover.ts.',
    );
  }

  const urls: string[] = [];
  for (const [number, line] of contents.split('\n').entries()) {
    const uri = uriOnLine(line);
    if (uri === undefined) continue;
    try {
      new URL(uri);
    } catch {
      throw new Error(`${path} regel ${number + 1}: geen geldige URI — "${uri}"`);
    }
    if (!urls.includes(uri)) urls.push(uri);
  }

  if (urls.length === 0) throw new Error(`${path} bevat geen dataset-URI's.`);
  return urls;
}

/**
 * Een lijst URI's, tolerant gelezen: een ontbrekend bestand is een lege lijst.
 *
 * Gebruikt voor `etc/workaround-uris.txt`, dat optioneel is — wie geen
 * uitzonderingen heeft, hoort er ook geen bestand voor te hoeven maken.
 */
export async function readUriList(path: string): Promise<Set<string>> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return new Set();
  }
  const uris = new Set<string>();
  for (const line of contents.split('\n')) {
    const uri = uriOnLine(line);
    if (uri !== undefined) uris.add(uri);
  }
  return uris;
}

export interface ExistingUris {
  /** Alles wat er al in staat, actief of uitgecommentarieerd. */
  uris: Set<string>;
  /** Daarvan de uitgecommentarieerde; alleen om te melden. */
  disabled: Set<string>;
  /** URI's die meer dan één keer voorkomen; alleen om te melden. */
  duplicates: string[];
  /** Bestaat het bestand al? */
  exists: boolean;
  /** Eindigt het bestand op een nieuwe regel? Zo niet, eerst één toevoegen. */
  endsWithNewline: boolean;
}

/**
 * Wat er al in het configuratiebestand staat — tolerant.
 *
 * Anders dan `readDatasetList` keurt dit niets af: een ontbrekend bestand is
 * gewoon leeg en een regel die geen geldige URI is telt gewoon mee als
 * "aanwezig". Het doel is enkel weten wat er niet nóg een keer bij moet.
 */
export async function readExistingUris(path: string): Promise<ExistingUris> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return {
      uris: new Set(),
      disabled: new Set(),
      duplicates: [],
      exists: false,
      endsWithNewline: true,
    };
  }

  const uris = new Set<string>();
  const disabled = new Set<string>();
  const active = new Set<string>();
  const duplicates: string[] = [];
  for (const line of contents.split('\n')) {
    const known = knownUriOnLine(line);
    if (known === undefined) continue;
    uris.add(known);
    if (uriOnLine(line) === undefined) {
      disabled.add(known);
      continue;
    }
    // Dubbel is alleen dubbel als de URI twee keer actief is; één actieve en
    // één uitgezette regel is een normale manier om iets te bewaren.
    if (active.has(known) && !duplicates.includes(known)) duplicates.push(known);
    active.add(known);
  }

  return {
    uris,
    disabled,
    duplicates,
    exists: true,
    endsWithNewline: contents === '' || contents.endsWith('\n'),
  };
}
