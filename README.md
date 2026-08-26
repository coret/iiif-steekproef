# iiif-steekproef

Publiceert van elke dataset in `bin/datasets.txt` een steekproef IIIF-manifesten
als IIIF Presentation 3 **Collection** op
<https://iiif-steekproef.coret.org/>.

Gebouwd op [LD Elements](https://ldelements.org/).

## Draaien

```sh
cd bin
npm install
npx tsx src/sampler.ts               # alle datasets uit datasets.txt
npx tsx src/sampler.ts <dataset-URI>  # alleen deze; de rest van de index blijft staan
npx tsx src/sampler.ts --help
```

De applicatie staat in `bin/`: **alle `npx`-opdrachten in dit bestand draai je
vanuit die map.** Verwijzingen naar bestanden in de lopende tekst zijn juist
vanaf de repo-root geschreven, dus met `bin/` ervoor.

Voortgang gaat naar stderr, de gepubliceerde URL's naar stdout.

## Wat het doet

1. **Manifesten opvragen bij het Dataset Knowledge Graph**
   (`bin/src/knowledge-graph.ts`). NDE valideert per dataset een steekproef
   IIIF-manifesten met SHACL en legt met PROV vast wélke manifesten het daarbij
   heeft opgehaald. Precies die IRI's halen we op — één SPARQL-query voor alle
   datasets tegelijk.
2. **Metadata ophalen uit het Dataset Register** (`bin/src/registry.ts`), ook in
   één keer voor de hele lijst, via `@lde/dataset-registry-client`. Kent het
   register een dataset niet, dan valt hij terug op de datasetbeschrijving van
   de uitgever zelf (`bin/src/dataset-description.ts`).
3. **Steekproef en controle** (`bin/src/manifests.ts`). Fisher-Yates met een
   seedbare PRNG, daarna `@lde/iiif-validator` per kandidaat. Die dereferenceert
   het manifest én draait `@iiif/parser`'s `upgrade()` + `normalize()` — exact de
   laadroute van Theseus, Mirador en Clover. Manifesten die daar stuklopen komen
   niet in de collection.
4. **Publiceren** (`bin/src/collection.ts`, `bin/src/site.ts`). Eén Collection
   per dataset plus een `index.html` met keuzelijst en Tify-viewer.

`bin/src/render.ts` bouwt `index.html` opnieuw uit `catalogs.json`, zonder
opnieuw te bemonsteren — voor na een wijziging in het sjabloon, of om lokaal te
testen met een andere basis-URL:

```sh
npx tsx src/render.ts --base-url http://localhost:8099
```

## Waarom het DKG en niet de RDF-dumps

De eerste versie deed het anders: datasetbeschrijving ophalen, distributie
kiezen, de hele RDF-dump downloaden en streamend parsen, en daaruit zelf alle
manifest-IRI's vissen. Dat werkte, maar het schaalde slecht en het leverde niet
eens altijd meer op:

- **De dumps zijn groot.** Twee datasets vulden de cache al met 3 GB; FEHAC
  alleen al is een RDF/XML-bestand van 2,4 GB met 34 miljoen triples.
- **Het paste niet in het geheugen.** Bij het Nederlands Fotomuseum liep het
  proces vast op de heap-limiet van Node. Oorzaak: de parser levert de IRI's als
  deelstrings van de leesbuffer, en wie er één bewaart houdt de hele chunk in
  leven — gemeten 13,6 KB heap per bewaarde URI van ~70 bytes.
- **De dump wist het soms niet.** In diezelfde FEHAC-dump komt het woord `iiif`
  geen enkele keer voor, terwijl het DKG er ruim een miljoen manifesten aan
  toeschrijft — en tien concrete manifest-IRI's van kent.

Die dump-route is overigens niet verdwenen maar gedegradeerd tot uitzondering:
zie [Workaround](#workaround-toch-uit-de-distributie) voor de handvol datasets
waar hij nog wél de enige weg is.

Wat het kost: het DKG legt **hoogstens tien manifesten per dataset** vast, en
elke run zijn dat dezelfde tien. Het is dus NDE's steekproef en niet elke keer
een verse eigen greep. Van de 135 datasets in `bin/datasets.txt` hebben er
**84 manifesten in het DKG**, samen 673 IRI's; bij de overige 51 heeft NDE's
IIIF-validatie wél gedraaid maar geen enkel manifest vastgelegd.

De run van 26 augustus 2026 leverde daarmee **55 datasets met 433 manifesten**
op; overgeslagen: 80 — de 51 zonder manifest-IRI's, plus de rest waarvan géén
enkel manifest laadde. Die verhouding schommelt per run: dezelfde bronnen geven
niet elke dag hetzelfde antwoord, dus een time-out of een 404 meer of minder
verschuift de telling. Daarvan is **34 van de 55** in een browser onbereikbaar
door de ARK-keten — zie [CORS](#cors).

## Fouten zichtbaar maken

Bij hoogstens tien manifesten per dataset is een kapot manifest geen ruis maar
uitkomst: het zegt evenveel over de bron als een werkend manifest. Daarom
verdwijnt geen enkele afkeuring in het log.

- **Per manifest** legt `bin/src/manifests.ts` een `Rejection` vast: de IRI, de
  reden, en bij een HTTP-fout de status. Die staan in `catalogs.json` en
  verschijnen onder de kerngegevens van de dataset op de pagina — "HTTP 404",
  "time-out", "laadt niet in een viewer", "geen inhoud".
- **Geen inhoud** is een eigen controle, geen oordeel van de validator: een
  manifest zonder canvas komt door `normalize()` heen maar valt in een viewer
  leeg open. Voor wie de steekproef bekijkt is dat net zo goed een fout.
- **Per dataset** komen de datasets die niets opleverden in `failures.json`, en
  daarmee in een dichtgeklapte lijst onder de keuzelijst. Zonder dat verdween de
  meest sprekende fout van de site: een bron waarvan álle manifesten stuk zijn,
  stond nergens meer.
- **Gegroepeerd per soort probleem**, met het aantal in de kop: geen
  manifest-IRI's in het DKG, geen enkel manifest dat laadt (uitgesplitst naar
  HTTP-fout, laadt niet in een viewer, time-out, server onbereikbaar,
  verschillende oorzaken), of anders mislukt. De run zet die categorie zelf in
  de ledger (`category` en `detail`); staat hij er niet in, dan leidt de pagina
  hem uit de melding af. Binnen een groep waarin elke melding hetzelfde zegt,
  vervalt die tekst per regel — dat scheelt bij de grootste groep vijftig keer
  dezelfde zin.
- **Naar het register.** De datasetnaam in die lijst linkt naar
  `datasetregister.netwerkdigitaalerfgoed.nl/dataset?uri=…`, in een venster met
  een vaste naam, zodat een rij aflopen niet twintig tabbladen oplevert.
- **Zelf nakijken.** Achter elke overgeslagen dataset staat een **SPARQL**-link
  naar [YASGUI](https://yasgui.coret.org/), met het DKG-endpoint en een query
  die de manifest-IRI's van precies die dataset opvraagt. Geen resultaten is
  daar een antwoord en geen storing: dan kent het DKG er geen. Komen er wél
  IRI's uit, dan ligt het aan de manifesten zelf — de reden ernaast zegt welke.
  De link wordt gebouwd in `yasguiUrl()` in `bin/src/site.ts`; de query is
  dezelfde als in `bin/src/knowledge-graph.ts`, op één dataset toegespitst.

## Workaround: toch uit de distributie

Voor sommige datasets legt het DKG niets bruikbaars vast terwijl de
RDF-distributie wél deugt. `KW - Kamp Westerbork - Collecties` is het
schoolvoorbeeld: nul manifest-IRI's in het DKG, 15.101 in de dump.

Staat een dataset-URI in `etc/workaround-uris.txt`, dan wordt **na** een mislukte
DKG-route alsnog de distributie opgehaald en daar een steekproef van 25
manifesten uit getrokken:

```
# etc/workaround-uris.txt — één URI per regel, # is commentaar
https://kenniscentrum.kampwesterbork.nl/atlantispubliek/data/dataset/KW+-+Kamp+Westerbork+-+Collecties
```

De foutmelding blijft staan, met `verwerkt via workaround` erachter. Dat is geen
slordigheid: dát het DKG niets had blijft waar, en zo is te zien dat die dataset
langs een andere weg in de index kwam. Mislukt de workaround ook, dan komt die
tweede reden erbij in plaats van de markering.

Wat welk onderdeel doet:

- **kiezen** — `probe()` uit `@lde/distribution-probe`, op voorkeursvolgorde
  (N-Triples eerst, JSON-LD laatst). De eerste die de probe overleeft wint.
- **ophalen** — `LastModifiedDownloader` uit `@lde/distribution-downloader`, naar
  `bin/data/`.
- **uitlezen** — streamend met `rdf-parse` (`bin/src/distribution.ts`). Hiervoor
  heeft LDE geen los onderdeel: `@lde/pipeline` werkt met SPARQL-lezers en
  -schrijvers, en zijn antwoord op een dump is hem importeren in een SPARQL-store
  (`ImportResolver`, `@lde/sparql-qlever`). Dat is precies de zwaarte die deze
  tool niet wil.

Twee dingen om te weten voor je een URI toevoegt. Ten eerste kost dit véél meer
dan een SPARQL-query: de dump wordt gedownload en helemaal doorgelezen. Ten
tweede werkt de cache alleen als de server zegt wanneer het bestand veranderde;
Atlantis stuurt geen `Last-Modified`, dus daar wordt elke run opnieuw
gedownload.

### Geheugen

De parser levert IRI's als deelstrings van de leesbuffer, en wie er één bewaart
houdt de hele chunk in leven. Gemeten: 13,6 KB heap per bewaarde URI van ~70
bytes — bij het Nederlands Fotomuseum liep dat na 273.000 URI's tegen Node's
heap-limiet aan en stierf het proces. `flat()` in `bin/src/distribution.ts` maakt
daarom van elke URI een platte kopie voor hij wordt bewaard. Zonder die regel
schaalt deze route niet voorbij een dump of wat.

## CORS

De sampler haalt alles met Node op, en Node houdt zich niet aan CORS. Een
bezoeker merkt dus iets wat de sampler niet kan ondervinden: staat de bron de
browser niet toe, dan blijft de viewer leeg terwijl er niets mis is met het
manifest.

Wat de browser wél en niet nodig heeft:

- **Het manifest** haalt Tify met `fetch` op — dat heeft CORS nodig.
- **`info.json`** van de Image API haalt OpenSeadragon met XHR op — dat heeft
  CORS nodig, en het kan apart geweigerd worden terwijl het manifest wél mag.
- **De beeldtegels zelf** niet: Tify laat OpenSeadragon op `crossOriginPolicy:
  false` staan, dus tegels laden als gewone `<img>`.

### Elke hop telt, niet alleen de laatste

Een naïeve controle — één `fetch`, kijken of het antwoord een
`Access-Control-Allow-Origin` heeft — geeft hier een vals goed nieuws. Node
volgt redirects stilzwijgend, dus je kijkt naar de láátste response, en juist
een tussenstap is vaak het probleem.

Het geval dat dit aan het licht bracht: manifest-IRI's die via een ARK lopen.

| # | response | ACAO |
|---|---|---|
| 1 | `n2t.net/ark:…/iiif.json` → 302 → arks.org | `*` |
| 2 | `arks.org/…` → 302 → `data.<bron>.nl` | aanwezig |
| 3 | `data.<bron>.nl/…` → 308 → `www.ldmax.nl/ark:…?host=…` | `*` |
| 4 | `www.ldmax.nl/ark:…?host=…` → 307 → `/organisaties/…/iiif.jsonld?term=…` | **ontbreekt** |
| 5 | eindadres → 200 | `*` |

Alleen stap 4 mist de header, en dat is genoeg: bij een CORS-verzoek
controleert de browser élke response in de keten. Het eindadres is prima — wie
dat rechtstreeks ophaalt merkt niets — maar via de ARK komt geen browser erbij.

Daarom loopt `browserCanFetch()` in `bin/src/manifests.ts` de keten zelf af met
`redirect: 'manual'` (in Node levert dat de echte 3xx-response mét headers op)
en toetst elke hop. Met één regel die makkelijk over het hoofd wordt gezien:
**zodra een redirect van origin wisselt, stuurt de browser `Origin: null`.** Een
server die de origin terugkaatst helpt vanaf dat punt dus niet meer; alleen `*`
komt er nog doorheen.

Wordt de browser geweigerd, dan staat op de dataset-kaart wáár het misging —
stap, host en status — zodat een lege viewer verklaard is in plaats van
raadselachtig.

### Waarom we het niet omzeilen

Het eindadres is in één hop gewoon op te halen, dus we zouden de opgeloste URL
kunnen publiceren in plaats van de ARK. Dat doen we bewust niet: het probleem
ligt bij de bron, het is daar gemeld, en een ARK in de collection vervangen
door een vluchtig eindadres levert een werkende viewer op ten koste van precies
de persistente identifier waar het om begonnen was. Proxyen via dit domein valt
om dezelfde reden af — dan serveren we andermans data onder onze naam.

## Tify

Tify opent op de **collectieweergave**: de bladerlijst met alle manifesten in de
steekproef. Klik je een manifest aan, dan schrijft Tify dat (met pagina en
zoomniveau) in de URL, zodat je die kunt delen; komt zo'n link binnen, dan opent
Tify dat manifest meteen.

Dat werkt via `urlQueryKey`. Tify's eigen `childManifestAutoloaded` doet hier
niets: die leest `collection.manifests`, de Presentation 2-vorm, terwijl een
v3-Collection `items` heeft. De constructor-optie `childManifestUrl` wordt bij
het opstarten evenmin gelezen — alleen de URL-status.

## Configuratie

`bin/datasets.txt` — één datasetbeschrijving-URI per regel. Lege regels en
regels die met `#` beginnen worden overgeslagen.

Bij een volledige run is dit bestand leidend: een dataset die eruit gehaald
wordt, verdwijnt uit `index.html`. Het bijbehorende JSON-bestand blijft wél
staan, zodat een eerder gedeelde collection-URL blijft werken.

## Datasets zoeken

`bin/src/discover.ts` vult `bin/datasets.txt` aan met datasets die
IIIF-manifesten bevatten, gevonden in het NDE Dataset Knowledge Graph:

```sh
npx tsx src/discover.ts --dry-run   # toon wat erbij zou komen
npx tsx src/discover.ts             # en voeg het toe
npx tsx src/discover.ts --help
```

Het criterium is dat van NDE's eigen zoekindex: een `void:subset` die
`dct:conformsTo <http://iiif.io/api/presentation/>` en `void:entities` heeft —
geen zelfbedachte heuristiek. De titels komen uit het Dataset Register; haalt
dat niet, dan gaat het toevoegen gewoon door en staat er `(geen titel in het
register)` boven de URI.

Let op: dat criterium zegt dat er IIIF ín de dataset zit, niet dat het DKG er
manifest-IRI's van kent. Een dataset kan dus keurig gevonden worden en bij het
bemonsteren alsnog afvallen.

Het bestand wordt **uitsluitend aangevuld, nooit herschreven**: aantekeningen
blijven staan, en een URI die er al staat komt er niet nog eens bij. Dat geldt
ook voor een uitgecommentarieerde URI — een uitgezette dataset is een genomen
besluit, en anders zette de eerstvolgende zoekronde hem er zo weer bij.

## Stabiele URL's

Een collection staat op `/manifests/<uuidv5(dataset-URI)>.json` — dezelfde
dataset krijgt bij elke run dezelfde URL. De inhoud ververst, de link blijft
geldig.

Die submap kwam er later bij. Collections stonden eerst los in de docroot, en
links naar dat oude pad geven een 404: er is bewust geen rewrite gezet. De UUID
veranderde niet, dus dezelfde dataset is te vinden op hetzelfde bestand, één map
dieper.

Let op dat het `id` ín een collection zijn eigen URL is. Verhuist de map, dan
moeten die velden mee — anders wijst elk bestand naar een adres waar het niet
meer staat, en dat is precies waar IIIF-viewers op vastlopen.

Valt een dataset uit de index, dan blijft zijn JSON-bestand staan: de run
verwijdert nooit iets uit `root/`. Zo'n weesbestand opruimen is dus een
handmatige keuze, en meteen het einde van elke gedeelde link ernaartoe.

## Mappen

```
bin/          deze applicatie (buiten de docroot)
  src/        broncode
  assets/     statische bestanden die meegaan naar de docroot (logo, favicon)
  data/       downloadcache van de workaround, blijft buiten git
  datasets.txt
etc/          workaround-uris.txt
root/         de docroot: index.html, catalogs.json, failures.json,
              .htaccess, bc-logo.png, favicon.ico
  manifests/  de gepubliceerde collections: <uuid>.json
```

Alles in `root/` wordt gegenereerd; bewerk daar niets met de hand.
`bc-logo.png` en `favicon.ico` komen uit `bin/assets/` en worden bij elke
publicatie opnieuw gekopieerd.

## Apache

De vhost staat niet in deze repo maar waar hij hoort, in
`/etc/apache2/sites-available/iiif-steekproef.coret.org.conf`. Hij wijst de
docroot naar `root/`.

`Access-Control-Allow-Origin: *` op `*.json` is **niet optioneel**: viewers halen
de collection vanuit de browser op. De vhost zet de header, en het gegenereerde
`root/.htaccess` doet het nog eens — zodat de publicatiemap op zichzelf compleet
is, ook als hij ooit ergens anders komt te staan.

## Bekende eigenaardigheden van bronnen

- **Manifesten die niet laden.** In `KW - Kamp Westerbork - Personen` bevat ruim
  tweederde van de manifesten een `null` waar een Canvas hoort. Bij
  `FEHAC - Beelddocumenten - Wegvoertuigen` staat een `null` waar de
  annotatielijst hoort, en klapt `normalize()` eruit op *Cannot read properties
  of null*; alle tien manifesten die het DKG van die dataset kent lopen daarop
  stuk, dus die dataset valt in zijn geheel af. Zulke manifesten renderen in
  geen enkele Vault-viewer, dus stap 3 filtert ze eruit en meldt het.
- **Te veel tegelijk is te veel.** Alle manifesten van één dataset staan bij
  dezelfde server. Met vijf gelijktijdige verzoeken liep bij `Krantenpaginas`
  (Coda Apeldoorn) 4 van de 9 manifesten in een time-out; met twee laadden ze
  alle negen. Vandaar `--concurrency 2` als standaard.
- **Tellingen die niet over de distributie gaan.** Het DKG schrijft aan
  `FEHAC - Beelddocumenten - Wegvoertuigen` ruim een miljoen IIIF-manifesten
  toe, maar de RDF/XML-distributie die je kunt downloaden bevat 34 miljoen
  triples zonder één vermelding van `iiif`. De telling en de distributie die er
  nu staat gaan dus niet over hetzelfde.
- **Manifest-IRI's die nergens heen wijzen.** Bij `Centraal Museum` zijn alle
  tien manifesten die het DKG kent `n2t.net/ark:`-URI's, en vijf daarvan geven
  een 404. De IRI is dus persistent bedoeld maar niet resolvebaar; de steekproef
  houdt er vier over en toont de vijf 404's erbij.
- **Geen `Last-Modified`.** De Atlantis-servers sturen bij een distributie wel
  een `Content-Length` maar geen `Last-Modified`. De downloader kan dan niet
  weten of de lokale kopie nog klopt en haalt hem elke run opnieuw op. De cache
  in `bin/data/` helpt dus alleen bij bronnen die het wél vertellen.
- **De ARK-keten van LDmax.** Veel bronnen publiceren hun manifest-IRI als
  `n2t.net/ark:…`, dat via arks.org en de bron uitkomt bij `www.ldmax.nl`. De
  307 daar mist een CORS-header, waardoor geen browser bij het manifest kan —
  zie [CORS](#cors). Server-side valt er niets van te merken.
- **HTML-entiteiten in labels.** Sommige manifest-labels bevatten letterlijk
  `&nbsp;`. Dat komt zo uit de bron; labels worden bewust niet herschreven.

## Logo

Het merkteken in de header is `bc-logo.png`, het beeldmerk van
[bob.coret.org](https://bob.coret.org/) (daar `root/img/bc.png`). Het favicon is
`favicon.ico` van diezelfde site: één `.ico` met meerdere formaten erin, die
browsers ook uit zichzelf op `/favicon.ico` opvragen. Het logo dient daarnaast
als `apple-touch-icon`.

Beide staan als bronbestand in `bin/assets/` en worden door `publishSite()`
meegekopieerd, zodat de publicatiemap op zichzelf compleet is en de pagina het
logo ook toont als je `index.html` rechtstreeks opent.

Het logo is vierkant (256 x 256). De CSS zet de hoogte (`2.5rem`, even hoog als
op de ErfgoedKijker) en laat de breedte volgen.

## Onderhoud

Nieuwe Tify-versie: pas `TIFY_VERSION` in `bin/src/site.ts` aan.

Ander logo of favicon: vervang `bin/assets/bc-logo.png` of
`bin/assets/favicon.ico` (of pas `LOGO`/`FAVICON` in `bin/src/site.ts` aan) en
draai `npx tsx src/render.ts`.

Let op bij `bin/src/site.ts`: de pagina zit in een template literal, dus **geen
backticks** gebruiken in het ingebedde CSS/JS — die sluiten de string af.
