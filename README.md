# Trekningslogikken for kaytomas.no/vinn

Dette er koden som trekker vinneren i giveawayene på [kaytomas.no/vinn](https://kaytomas.no/vinn). Den ligger åpent, slik at alle kan se nøyaktig hvordan en vinner blir valgt.

Her ligger bare koden. Lister over deltakere, navn og resultater legges aldri ut. Trekningen kjøres lokalt hos arrangøren, mot arrangørens egen database.

## Slik trekkes en vinner

1. Når påmeldingen er stengt, låses lista. Hver påmelding blir ett lodd.
2. Samtidig pekes det ut en runde hos [drand](https://drand.love) som ennå ikke finnes, noen sekunder fram i tid. drand er en åpen tjeneste som lager et nytt tilfeldig tall hvert tredje sekund.
3. Når runden kommer, bestemmer tallet derfra sammen med den låste lista hvilket lodd som vinner.
4. Hjulet som snurrer på skjermen viser dette resultatet. Hjulet bestemmer ingenting selv.

Hele regnestykket står i én fil: [lib/trekning.mjs](lib/trekning.mjs).

## Hva koden sørger for

**Alle lodd har lik sjanse.** Tallet gjøres om til en plass i lista med en metode som forkaster de verdiene som ellers ville gitt de første loddene en ørliten fordel. [Testene](test/trekning.test.mjs) sjekker at fordelingen er jevn.

**Én person, ett lodd.** Alle som melder seg på er logget inn med Vipps, og databasen tillater ett lodd per person i hver giveaway.

**Tallet lages ikke av arrangøren.** Det kommer fra [drand](https://github.com/drand/drand), som drives av League of Entropy: en gruppe uavhengige organisasjoner, blant dem Cloudflare og Protocol Labs. Hver runde er signert, og koden sjekker signaturen mot nettverkets offentlige nøkkel.

**Det trekkes én gang.** Hvilken runde som gjelder, bestemmes når lista låses. Koden nekter å låse lista to ganger og nekter å overskrive et resultat.

**Ingen kan meldes på eller av etter fristen.** Databasen stenger for påmelding og avmelding på trekningstidspunktet, og koden nekter å låse lista før det.

Koden viser hvordan trekningen foregår. Siden listene ikke legges ut, kan ikke andre regne ut en bestemt trekning på nytt. Arrangøren tar vare på den låste lista, drand-runden og resultatet for hver trekning.

## Hvis vinneren ikke svarer

Vinneren har 14 dager på å svare. Etter det trekkes det på nytt på samme måte, med en ny drand-runde. Lista er den samme som i første trekning, og alle tidligere vinnere er tatt ut.

## Prøv selv

Du trenger [Node.js](https://nodejs.org) 22 eller nyere.

```bash
git clone https://github.com/ktbsen/vinn-trekning.git
cd vinn-trekning
npm install
npm test
```

I [`eksempel/`](eksempel) ligger en hel trekning med 180 oppdiktede deltakere og en ekte drand-runde. Denne kommandoen henter runden fra drand, sjekker signaturen og regner ut vinnerloddet på nytt:

```bash
VINN_TREKNINGER_DIR=eksempel/trekninger node vinn.mjs verifiser --signatur
```

Du kan også kjøre en hel trekning selv med de oppdiktede deltakerne:

```bash
export VINN_TESTDATA=/tmp/vinn-ove/db.json VINN_PRIVAT_DIR=/tmp/vinn-ove/filer
mkdir -p /tmp/vinn-ove && cp eksempel/testdata.json /tmp/vinn-ove/db.json
node vinn.mjs frys demo-giveaway
node vinn.mjs trekk demo-giveaway --vent
```

Så lenge `VINN_TESTDATA` er satt, snakker ingenting med en ekte database.

## For den som trekker

Koblingen til den ekte databasen ligger ikke i dette repoet. Koden her får bare det den trenger gjennom fem funksjoner, beskrevet i [lib/database.mjs](lib/database.mjs). Arrangørens egen kobling lastes fra en fil utenfor repoet.

```bash
# Når som helst: se hvor ting står. Leser bare, og viser aldri navn.
node --env-file=../kaytomas.com/.env.local vinn.mjs status

# 1. Etter at påmeldingen er stengt: lås lista. Tallet fra drand kommer 30 sekunder senere.
node --env-file=../kaytomas.com/.env.local vinn.mjs frys keychron-g5

# 2. Start hjulet og sving det.

# 3. Lagre vinneren og få kontaktinfoen.
node --env-file=../kaytomas.com/.env.local vinn.mjs trekk keychron-g5

# 4. Når premien er sendt: slett navnene til hjulet.
node vinn.mjs rydd keychron-g5
```

Alt om en trekning lagres i en lokal mappe hos arrangøren, utenfor alle repoer: den låste lista, resultatet og navnene til hjulet. `trekk` kan trygt kjøres flere ganger. Svaret er det samme hver gang.

## Lisens

MIT. Trekningen arrangeres av KTBSEN AS, som driver kaytomas.no. Vilkårene står på [kaytomas.no/vinn/vilkar](https://kaytomas.no/vinn/vilkar).
