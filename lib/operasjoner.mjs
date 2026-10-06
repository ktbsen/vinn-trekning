/**
 * The steps of a draw: frys (freeze the list and name a drand round that does
 * not exist yet), trekk (find the winner once that round exists) and
 * verifiser (check a draw again from its files).
 *
 * Everything runs on the organiser's own machine. The frozen list and the
 * result are written to a local folder, never to this repo.
 *
 * Nothing here ever overwrites a file. A frozen list and a result are written
 * once, with a flag that makes the write fail if the file is already there.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { KJEDE, hentRunde, rundeForTid, rundeUrl, tidForRunde } from './drand.mjs';
import { visningsnavn } from './navn.mjs';
import { ALGORITME, listehash, lodd, pott, sorterLodd, velgVinner, visLodd } from './trekning.mjs';

export const MINSTE_MARGIN_SEK = 10;
const SLUG = /^[a-z0-9-]{3,80}$/;

export class Stopp extends Error {}

const oslo = new Intl.DateTimeFormat('nb-NO', {
  timeZone: 'Europe/Oslo',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
export const tid = (date) => oslo.format(new Date(date));

export function privatMappe(env = process.env) {
  return env.VINN_PRIVAT_DIR || join(homedir(), '.kaytomas-vinn');
}

const forpliktelseFil = (n) => `${n}-forpliktelse.json`;
const resultatFil = (n) => `${n}-resultat.json`;
const hjulFil = (n) => `hjul-${n}.json`;

async function lesJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Kunne ikke lese ${path}: ${e.message}`);
  }
}

/** Writes a new file and fails if it already exists. */
async function skrivNy(path, data, mode) {
  try {
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode });
  } catch (e) {
    if (e.code === 'EEXIST') throw new Stopp(`${path} finnes allerede. Ingenting er overskrevet.`);
    throw e;
  }
}

/** Every draw of one giveaway, in order: [{ n, forpliktelse, resultat }]. */
export async function lesTrekninger(dir, slug) {
  if (!SLUG.test(slug ?? '')) throw new Stopp('Ugyldig giveaway-slug.');
  let files;
  try {
    files = await readdir(join(dir, slug));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const numbers = files
    .map((f) => /^(\d+)-forpliktelse\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const out = [];
  for (const n of numbers) {
    out.push({
      n,
      forpliktelse: await lesJson(join(dir, slug, forpliktelseFil(n))),
      resultat: await lesJson(join(dir, slug, resultatFil(n))),
    });
  }
  out.forEach((t, i) => {
    if (t.n !== i + 1) throw new Stopp(`Trekningene for ${slug} er ikke nummerert 1, 2, 3 uten hull.`);
  });
  return out;
}

export async function listGiveaways(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SLUG.test(e.name)).map((e) => e.name).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ─── status ──────────────────────────────────────────────────────────────

/** Read-only overview. Prints counts, never names. */
export async function status({ db, dir, slug, logg = console.log, na = () => new Date() }) {
  const giveaways = slug ? [await db.hentGiveaway(slug)].filter(Boolean) : await db.hentGiveaways();
  if (giveaways.length === 0) throw new Stopp(slug ? `Fant ingen giveaway med slug "${slug}".` : 'Ingen giveaways i databasen.');

  for (const giveaway of giveaways) {
    const entries = await db.hentPameldinger(giveaway.id);
    const medNavn = entries.filter((e) => e.navn && e.sted).length;
    const tickets = await Promise.all(entries.map((e) => lodd(e.id)));
    sorterLodd(tickets);
    const draws = await lesTrekninger(dir, giveaway.slug);
    const open = na().getTime() < new Date(giveaway.frist).getTime();

    logg(`\n${giveaway.tittel} (${giveaway.slug})`);
    logg(`  Trekkes:   ${tid(giveaway.frist)}${open ? ' (påmeldingen er åpen)' : ' (påmeldingen er stengt)'}`);
    logg(`  Påmeldte:  ${entries.length}, ${medNavn} med både navn og poststed`);
    logg(`  Database:  ${giveaway.trukket ? `trukket ${tid(giveaway.trukket)}` : 'ikke trukket'}`);
    if (draws.length === 0) {
      logg(`  Neste:     ${open ? 'vent til påmeldingen stenger, og kjør så frys' : 'kjør frys'}`);
    }
    for (const draw of draws) {
      const round = draw.forpliktelse.tilfeldighet;
      if (draw.resultat) {
        logg(`  Trekning ${draw.n}: vinnerlodd ${visLodd(draw.resultat.vinner.lodd)}, drand-runde ${round.runde}`);
      } else {
        const waiting = new Date(round.tidspunkt).getTime() > na().getTime();
        logg(`  Trekning ${draw.n}: frosset, drand-runde ${round.runde} (${tid(round.tidspunkt)}). ${waiting ? 'Venter på runden.' : 'Runden er ute, kjør trekk.'}`);
      }
    }
  }
}

// ─── frys ────────────────────────────────────────────────────────────────

/**
 * Freezes the list of tickets and names the drand round that will decide.
 * The round lies a little ahead in time, so its value does not exist yet.
 */
export async function frys({
  db,
  dir,
  privatDir = privatMappe(),
  slug,
  omSekunder = 30,
  klokka = null,
  omtrekning = false,
  logg = console.log,
  na = () => new Date(),
}) {
  const giveaway = await db.hentGiveaway(slug);
  if (!giveaway) throw new Stopp(`Fant ingen giveaway med slug "${slug}".`);
  const now = na();

  if (now.getTime() < new Date(giveaway.frist).getTime()) {
    throw new Stopp(`Påmeldingen er åpen til ${tid(giveaway.frist)}. Lista kan først fryses etter det.`);
  }

  const draws = await lesTrekninger(dir, slug);
  const last = draws[draws.length - 1];
  if (last && !last.resultat) {
    throw new Stopp(
      `Trekning ${last.n} er allerede frosset og venter på drand-runde ${last.forpliktelse.tilfeldighet.runde} ` +
        `(${tid(last.forpliktelse.tilfeldighet.tidspunkt)}). Kjør trekk.`,
    );
  }
  if (last && !omtrekning) {
    throw new Stopp(`${slug} er allerede trukket. Svarte ikke vinneren innen fristen, kjør frys med --omtrekning.`);
  }
  if (!last && omtrekning) throw new Stopp('--omtrekning gjelder bare en giveaway som allerede er trukket.');
  if (!last && (giveaway.trukket || giveaway.seed)) {
    throw new Stopp('Databasen sier at denne giveawayen allerede er trukket, men det finnes ingen trekning her. Stopper.');
  }

  const entries = await db.hentPameldinger(giveaway.id);
  const withTickets = await Promise.all(entries.map(async (e) => ({ ...e, lodd: await lodd(e.id) })));
  const byTicket = new Map(withTickets.map((e) => [e.lodd, e]));

  const n = draws.length + 1;
  // A redraw uses the list from the first draw, so nobody is added or removed
  // afterwards. Only the earlier winners are left out.
  const tickets = last ? draws[0].forpliktelse.lodd : sorterLodd(withTickets.map((e) => e.lodd));
  const utelatt = draws.map((d) => d.resultat.vinner.lodd);
  const pool = pott(tickets, utelatt);
  if (pool.length === 0) throw new Stopp('Ingen å trekke blant.');

  const target = klokka ? new Date(klokka) : new Date(now.getTime() + omSekunder * 1000);
  if (Number.isNaN(target.getTime())) throw new Stopp('Ugyldig tidspunkt for trekningen.');
  if (target.getTime() - now.getTime() < MINSTE_MARGIN_SEK * 1000) {
    throw new Stopp(`drand-runden må ligge minst ${MINSTE_MARGIN_SEK} sekunder fram i tid.`);
  }
  const runde = rundeForTid(target);

  const forpliktelse = {
    versjon: 1,
    algoritme: ALGORITME,
    giveaway: slug,
    trekning: n,
    frosset: now.toISOString(),
    antall: pool.length,
    listehash: await listehash(tickets),
    tilfeldighet: {
      kilde: KJEDE.navn,
      kjede: KJEDE.hash,
      runde,
      tidspunkt: tidForRunde(runde).toISOString(),
      url: rundeUrl(runde),
    },
    utelatt,
    lodd: tickets,
  };

  const hjul = {
    giveaway: slug,
    tittel: giveaway.tittel,
    trekning: n,
    deltakere: pool.map((ticket) => {
      const entry = byTicket.get(ticket);
      return {
        lodd: ticket,
        navn: entry ? visningsnavn(entry.navn, entry.sted) : 'Slettet konto',
        pameldingId: entry?.id ?? null,
        deltakerId: entry?.deltakerId ?? null,
      };
    }),
  };

  await mkdir(join(dir, slug), { recursive: true });
  await mkdir(join(privatDir, slug), { recursive: true, mode: 0o700 });
  const fil = join(dir, slug, forpliktelseFil(n));
  const privatFil = join(privatDir, slug, hjulFil(n));
  // The names first: if that fails, no frozen list is left behind.
  await skrivNy(privatFil, hjul, 0o600);
  try {
    await skrivNy(fil, forpliktelse);
  } catch (e) {
    await rm(privatFil, { force: true });
    throw e;
  }

  logg(`\n${giveaway.tittel} (${slug}), trekning ${n}`);
  logg(`Lista er frosset: ${pool.length} lodd i potten${utelatt.length ? `, ${utelatt.length} tidligere vinner(e) utelatt` : ''}.`);
  logg(`Fingeravtrykk:  ${forpliktelse.listehash}`);
  logg(`Avgjøres av:    drand-runde ${runde}, ${tid(forpliktelse.tilfeldighet.tidspunkt)}`);
  logg(`Låst liste:     ${fil}`);
  logg(`Navn til hjul:  ${privatFil}`);

  return { fil, privatFil, forpliktelse };
}

// ─── trekk ───────────────────────────────────────────────────────────────

async function ventPaRunde(runde, { na, logg }) {
  const wait = tidForRunde(runde).getTime() - na().getTime();
  if (wait > 0) {
    logg(`Venter ${Math.ceil(wait / 1000)} sekunder på drand-runde ${runde} ...`);
    await new Promise((resolve) => setTimeout(resolve, wait + 1500));
  }
}

async function hentRundeMedForsok(hent, runde, signatur) {
  let lastError;
  for (let i = 0; i < 10; i++) {
    try {
      return await hent(runde, { signatur });
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

function seedTekst(n, round) {
  return `drand-quicknet:${round.runde}:${round.tilfeldighet}:trekning-${n}`;
}

/** Computes the result of one commitment from a drand round. No side effects. */
export async function regnUt(forpliktelse, round) {
  const pick = await velgVinner({
    giveaway: forpliktelse.giveaway,
    trekning: forpliktelse.trekning,
    lodd: forpliktelse.lodd,
    utelatt: forpliktelse.utelatt,
    tilfeldighet: round.tilfeldighet,
  });
  return {
    versjon: 1,
    algoritme: ALGORITME,
    giveaway: forpliktelse.giveaway,
    trekning: forpliktelse.trekning,
    listehash: pick.listehash,
    antall: pick.antall,
    tilfeldighet: {
      kilde: KJEDE.navn,
      kjede: KJEDE.hash,
      runde: round.runde,
      tidspunkt: tidForRunde(round.runde).toISOString(),
      url: rundeUrl(round.runde),
      verdi: round.tilfeldighet,
      signatur: round.signatur,
    },
    vinner: { lodd: pick.vinner, plass: pick.indeks + 1 },
    bevis: { melding: pick.melding, sha256: pick.sha256, forsok: pick.forsok },
  };
}

/**
 * Finds the winner of the frozen draw, writes the result file and stores the
 * winner in the database. Safe to run again: the result is the same every
 * time, and nothing that exists is replaced.
 */
export async function trekk({
  db,
  dir,
  privatDir = privatMappe(),
  slug,
  vent = false,
  signatur = true,
  hent = hentRunde,
  logg = console.log,
  na = () => new Date(),
}) {
  const draws = await lesTrekninger(dir, slug);
  if (draws.length === 0) throw new Stopp(`${slug} er ikke frosset. Kjør frys først.`);
  const draw = draws[draws.length - 1];
  const { forpliktelse, n } = draw;
  const utFil = join(dir, slug, resultatFil(n));
  const runde = forpliktelse.tilfeldighet.runde;

  if (tidForRunde(runde).getTime() > na().getTime()) {
    if (!vent) throw new Stopp(`drand-runde ${runde} kommer ${tid(tidForRunde(runde))}. Kjør med --vent for å vente.`);
    await ventPaRunde(runde, { na, logg });
  }

  const round = await hentRundeMedForsok(hent, runde, signatur);
  const resultat = await regnUt(forpliktelse, round);

  if (draw.resultat) {
    if (draw.resultat.vinner.lodd !== resultat.vinner.lodd || draw.resultat.tilfeldighet.verdi !== round.tilfeldighet) {
      throw new Stopp(`${utFil} stemmer ikke med det drand og lista gir. Noe er endret. Stopper.`);
    }
  } else {
    await skrivNy(utFil, { ...resultat, trukket: na().toISOString() });
  }

  logg(`\n${slug}, trekning ${n}`);
  logg(`drand-runde ${runde}: ${round.tilfeldighet}`);
  logg(`  ${round.kilderSomSvarte ?? '?'} kilder svarte likt${round.signaturSjekket ? ', signaturen er sjekket' : ', signaturen er IKKE sjekket'}`);
  logg(`Vinnerlodd: ${visLodd(resultat.vinner.lodd)} (plass ${resultat.vinner.plass} av ${resultat.antall} i den sorterte lista)`);
  logg(`Resultatfil: ${utFil}`);

  // From here on: who the ticket belongs to, and the database.
  const giveaway = await db.hentGiveaway(slug);
  if (!giveaway) throw new Stopp(`Fant ikke ${slug} i databasen. Resultatfila er skrevet, men vinneren er ikke lagret.`);

  const hjul = await lesJson(join(privatDir, slug, hjulFil(n)));
  let winner = hjul?.deltakere.find((d) => d.lodd === resultat.vinner.lodd) ?? null;
  if (!winner?.deltakerId) {
    for (const entry of await db.hentPameldinger(giveaway.id)) {
      if ((await lodd(entry.id)) === resultat.vinner.lodd) {
        winner = { lodd: resultat.vinner.lodd, navn: visningsnavn(entry.navn, entry.sted), deltakerId: entry.deltakerId };
      }
    }
  }
  const kontakt = winner?.deltakerId ? await db.hentKontakt(winner.deltakerId) : null;
  if (!kontakt) {
    logg('\nVinnerloddet tilhører en konto som er slettet, så vinneren kan ikke kontaktes.');
    logg('Resultatet står. Trekk en ny vinner med: frys --omtrekning, og så trekk.');
    return { resultat, utFil, kontakt: null, lagret: false };
  }

  const display = visningsnavn(kontakt.navn, kontakt.poststed);
  // Shown before the database is touched, so a failed save never hides the winner.
  logg('\nKontakt vinneren (har 7 dager på å svare):');
  logg(`  Navn:     ${kontakt.navn ?? ''}`);
  logg(`  E-post:   ${kontakt.epost ?? ''}`);
  logg(`  Telefon:  ${kontakt.telefon ?? ''}`);
  logg(`  Poststed: ${[kontakt.postnummer, kontakt.poststed].filter(Boolean).join(' ')}`);
  logg('\nLinja til giveaway-fila når vinneren har svart:');
  logg(`  winnerDisplay: "${display}"`);

  const seed = seedTekst(n, round);
  let lagret = giveaway.seed === seed;
  if (!lagret) {
    // The database may hold nothing, or an earlier draw of this same giveaway.
    // Anything else means someone else has written to it, and we stop.
    const kjente = new Set([null]);
    for (const d of draws.slice(0, n - 1)) {
      kjente.add(seedTekst(d.n, { runde: d.resultat.tilfeldighet.runde, tilfeldighet: d.resultat.tilfeldighet.verdi }));
    }
    const forventet = giveaway.seed ?? null;
    if (!kjente.has(forventet)) {
      throw new Stopp(
        'Databasen har en trekning lagret som ikke finnes her, så vinneren er IKKE lagret.\n' +
          `  i databasen: ${giveaway.seed}`,
      );
    }
    if (n === 1 && giveaway.trukket) {
      throw new Stopp('Databasen sier at giveawayen allerede er trukket på en annen måte. Vinneren er IKKE lagret.');
    }
    lagret = await db.lagreVinner(giveaway.id, {
      deltakerId: winner.deltakerId,
      tidspunkt: na().toISOString(),
      seed,
      forventetSeed: forventet,
    });
    if (!lagret) throw new Stopp('Databasen ble endret underveis, så vinneren er IKKE lagret. Kjør trekk igjen.');
  }

  logg('\nVinneren er lagret i databasen.');
  logg('\nSvarer ikke vinneren innen 7 dager: frys --omtrekning, og så trekk.');

  return { resultat, utFil, kontakt, lagret, display };
}

// ─── verifiser ───────────────────────────────────────────────────────────

/**
 * Checks every draw in a folder from the files alone: the list, the drand
 * round and the winner must fit together. Needs no database and no keys.
 * Returns the number of errors.
 */
export async function verifiser({
  dir,
  slug = null,
  signatur = false,
  hent = hentRunde,
  logg = console.log,
  na = () => new Date(),
}) {
  const slugs = slug ? [slug] : await listGiveaways(dir);
  let feil = 0;
  let sjekket = 0;
  const bad = (text) => {
    feil++;
    logg(`  FEIL: ${text}`);
  };

  for (const s of slugs) {
    const draws = await lesTrekninger(dir, s);
    if (draws.length === 0) {
      if (slug) throw new Stopp(`Fant ingen trekning for "${s}".`);
      continue;
    }
    logg(`\n${s}`);

    for (const draw of draws) {
      const f = draw.forpliktelse;
      const round = f.tilfeldighet;
      sjekket++;
      logg(` Trekning ${draw.n}: ${f.antall} lodd i potten, drand-runde ${round.runde} (${tid(round.tidspunkt)})`);

      try {
        if (f.algoritme !== ALGORITME) bad(`ukjent algoritme ${f.algoritme}`);
        if (f.giveaway !== s || f.trekning !== draw.n) bad('fila ligger på feil sted');
        if (JSON.stringify(sorterLodd(f.lodd)) !== JSON.stringify(f.lodd)) bad('lista er ikke sortert');
        if ((await listehash(f.lodd)) !== f.listehash) bad('fingeravtrykket stemmer ikke med lista');
        if (pott(f.lodd, f.utelatt).length !== f.antall) bad('antallet stemmer ikke med lista');
        if (round.kjede !== KJEDE.hash) bad('feil drand-kjede');
        if (tidForRunde(round.runde).toISOString() !== round.tidspunkt) bad('tidspunktet stemmer ikke med rundenummeret');
        if (new Date(f.frosset).getTime() >= new Date(round.tidspunkt).getTime()) bad('lista ble frosset etter at drand-runden var ute');

        const earlier = draws.slice(0, draw.n - 1);
        if (JSON.stringify(f.lodd) !== JSON.stringify(draws[0].forpliktelse.lodd)) bad('lista er endret siden første trekning');
        if (JSON.stringify(f.utelatt) !== JSON.stringify(earlier.map((d) => d.resultat?.vinner.lodd))) {
          bad('utelatte lodd er ikke nøyaktig de tidligere vinnerne');
        }

        if (new Date(round.tidspunkt).getTime() > na().getTime()) {
          const seconds = Math.round((new Date(round.tidspunkt).getTime() - na().getTime()) / 1000);
          logg(`  Venter: drand-runden finnes ikke ennå. Den kommer om ${seconds} sekunder.`);
          if (draw.resultat) bad('det finnes et resultat før drand-runden er ute');
          continue;
        }

        const fetched = await hent(round.runde, { signatur });
        const expected = await regnUt(f, fetched);
        logg(`  drand: ${fetched.tilfeldighet}${fetched.signaturSjekket ? ' (signatur sjekket)' : ''}`);

        if (!draw.resultat) {
          logg(`  Ikke trukket ennå. Lista og drand gir vinnerlodd ${visLodd(expected.vinner.lodd)}.`);
          continue;
        }
        const r = draw.resultat;
        if (r.tilfeldighet.runde !== round.runde) bad('resultatet bruker en annen drand-runde enn den som ble varslet');
        if (r.tilfeldighet.verdi !== fetched.tilfeldighet) bad('resultatet bruker en annen verdi enn drand ga');
        if (r.listehash !== f.listehash) bad('resultatet gjelder en annen liste');
        if (r.vinner.lodd !== expected.vinner.lodd || r.vinner.plass !== expected.vinner.plass) {
          bad(`vinnerloddet skulle vært ${visLodd(expected.vinner.lodd)}, men resultatet sier ${visLodd(r.vinner.lodd)}`);
        } else {
          logg(`  OK: vinnerlodd ${visLodd(r.vinner.lodd)}, plass ${r.vinner.plass} av ${r.antall}.`);
        }
      } catch (e) {
        if (e instanceof Stopp) throw e;
        bad(e.message);
      }
    }
  }

  logg(`\n${sjekket} trekning(er) sjekket, ${feil} feil.`);
  return feil;
}

// ─── rydd ────────────────────────────────────────────────────────────────

/**
 * Deletes the files with names for one giveaway (hjul-*.json). The frozen
 * list and the result, which hold only ticket numbers, are kept as the log.
 */
export async function rydd({ privatDir = privatMappe(), slug, logg = console.log }) {
  if (!SLUG.test(slug ?? '')) throw new Stopp('Ugyldig giveaway-slug.');
  const path = join(privatDir, slug);
  let files = [];
  try {
    files = (await readdir(path)).filter((f) => /^hjul-\d+\.json$/.test(f));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const f of files) await rm(join(path, f), { force: true });
  logg(`Slettet ${files.length} fil(er) med navn i ${path}.`);
}
