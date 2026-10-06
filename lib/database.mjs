/**
 * What the draw needs from a database, and nothing more.
 *
 * The draw code never talks to a real database itself. It is handed an object
 * with the five functions below. The organiser's own adapter, which knows the
 * real database, is kept outside this repo and loaded from a file path.
 *
 *   hentGiveaway(slug)        -> { id, slug, tittel, frist, trukket, seed } or null
 *   hentGiveaways()           -> a list of the same
 *   hentPameldinger(id)       -> [{ id, deltakerId, navn, sted }], one per entry
 *   hentKontakt(deltakerId)   -> { navn, epost, telefon, postnummer, poststed } or null
 *   lagreVinner(id, { deltakerId, tidspunkt, seed, forventetSeed }) -> true when stored
 *
 * `frist` is when entries close. `seed` is the text the draw stored last
 * time, or null. lagreVinner must only store the winner when the giveaway's
 * seed still equals `forventetSeed`, so one draw can never replace another.
 * The draw never deletes anything.
 *
 * This file also holds a small database in a JSON file with the same
 * functions, for the tests and for trying the draw with made-up people.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function filDatabase(path) {
  const read = async () => JSON.parse(await readFile(path, 'utf8'));
  const giveaway = (g) => ({ id: g.id, slug: g.slug, tittel: g.tittel, frist: g.frist, trukket: g.trukket ?? null, seed: g.seed ?? null });
  return {
    navn: `testfil ${path}`,
    async hentGiveaway(slug) {
      const found = (await read()).giveaways.find((g) => g.slug === slug);
      return found ? giveaway(found) : null;
    },
    async hentGiveaways() {
      return (await read()).giveaways.map(giveaway);
    },
    async hentPameldinger(giveawayId) {
      const data = await read();
      return data.pameldinger
        .filter((p) => p.giveaway === giveawayId)
        .map((p) => {
          const person = data.deltakere.find((d) => d.id === p.deltaker);
          return { id: p.id, deltakerId: p.deltaker, navn: person?.navn ?? null, sted: person?.poststed ?? null };
        });
    },
    async hentKontakt(deltakerId) {
      const person = (await read()).deltakere.find((d) => d.id === deltakerId);
      if (!person) return null;
      return { navn: person.navn, epost: person.epost, telefon: person.telefon, postnummer: person.postnummer, poststed: person.poststed };
    },
    async lagreVinner(giveawayId, { deltakerId, tidspunkt, seed, forventetSeed }) {
      const data = await read();
      const found = data.giveaways.find((g) => g.id === giveawayId);
      if (!found || (found.seed ?? null) !== forventetSeed) return false;
      Object.assign(found, { vinner: deltakerId, trukket: tidspunkt, seed });
      await writeFile(path, JSON.stringify(data, null, 2));
      return true;
    },
  };
}

const FUNKSJONER = ['hentGiveaway', 'hentGiveaways', 'hentPameldinger', 'hentKontakt', 'lagreVinner'];

/**
 * VINN_TESTDATA points at a JSON file with made-up people. Otherwise the
 * organiser's adapter is loaded from VINN_DATABASE, or from its usual place
 * beside this repo.
 */
export async function apneDatabase(env = process.env) {
  if (env.VINN_TESTDATA) return filDatabase(env.VINN_TESTDATA);

  const rot = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = resolve(env.VINN_DATABASE || join(rot, '..', 'kaytomas.com', 'scripts', 'vinn-database.mjs'));
  if (!existsSync(path)) {
    throw new Error(
      `Fant ikke databasekoblingen (${path}).\n` +
        'Sett VINN_DATABASE til fila, eller VINN_TESTDATA for å prøve med oppdiktede deltakere.',
    );
  }
  const db = (await import(pathToFileURL(path).href)).apneDatabase(env);
  for (const f of FUNKSJONER) {
    if (typeof db?.[f] !== 'function') throw new Error(`Databasekoblingen mangler funksjonen ${f}.`);
  }
  return db;
}
