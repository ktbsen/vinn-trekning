#!/usr/bin/env node
/**
 * Trekning for kaytomas.no/vinn. Alt kjøres lokalt hos arrangøren.
 *
 *   node --env-file=<.env.local> vinn.mjs status [slug]
 *   node --env-file=<.env.local> vinn.mjs frys <slug> [--om <sekunder> | --kl <tidspunkt>] [--omtrekning]
 *   node --env-file=<.env.local> vinn.mjs trekk <slug> [--vent]
 *
 * Med --prove på frys og trekk kjøres en prøve på den ekte lista: alt leses og
 * regnes ut, men ingen vinner lagres, og prøven ligger i sin egen mappe.
 *   node vinn.mjs verifiser [slug] [--signatur]
 *   node vinn.mjs rydd <slug>
 *
 * Den låste lista, resultatet og navnene til hjulet skrives til en lokal
 * mappe (~/.kaytomas-vinn), aldri til dette repoet. Se README.md.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { apneDatabase } from './lib/database.mjs';
import { Stopp, frys, privatMappe, rydd, status, tid, trekk, verifiser } from './lib/operasjoner.mjs';

const [kommando, ...rest] = process.argv.slice(2);
const flagg = new Set(rest.filter((a) => a.startsWith('--')));

// --prove is a rehearsal on the real list. It uses its own folder, so it can
// never stand in the way of the real draw, and it never stores a winner.
const prove = flagg.has('--prove');
const privatDir = prove ? join(privatMappe(), 'prove') : privatMappe();
const dir = prove ? privatDir : process.env.VINN_TREKNINGER_DIR || privatDir;

/** A missing or broken database adapter is a plain message, not a stack trace. */
async function database() {
  const db = await apneDatabase().catch((e) => {
    throw new Stopp(e.message);
  });
  if (!prove) return db;
  // In a rehearsal the giveaway looks closed and undrawn, and saving is blocked.
  const somStengt = (g) => (g ? { ...g, frist: new Date(0).toISOString(), trukket: null, seed: null } : g);
  return {
    ...db,
    hentGiveaway: async (slug) => somStengt(await db.hentGiveaway(slug)),
    hentGiveaways: async () => (await db.hentGiveaways()).map(somStengt),
    lagreVinner: async () => {
      throw new Stopp('En prøve lagrer aldri en vinner.');
    },
  };
}

const verdi = (navn) => {
  const i = rest.indexOf(navn);
  return i >= 0 ? rest[i + 1] : null;
};
const verdiFlagg = ['--om', '--kl'];
const slug = rest.find((a, i) => !a.startsWith('--') && !verdiFlagg.includes(rest[i - 1])) ?? null;

function bruk() {
  console.log(
    [
      'Bruk:',
      '  node --env-file=<.env.local> vinn.mjs status [slug]',
      '  node --env-file=<.env.local> vinn.mjs frys <slug> [--om <sekunder> | --kl <tidspunkt>] [--omtrekning]',
      '  node --env-file=<.env.local> vinn.mjs trekk <slug> [--vent]',
      '  node vinn.mjs verifiser [slug] [--signatur]',
      '  node vinn.mjs rydd <slug>',
    ].join('\n'),
  );
}

/** "21:15" means today in local time. Anything else is read as a full date. */
function lesKlokke(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return new Date(text);
  const date = new Date();
  date.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return date;
}

async function harSignaturPakke() {
  try {
    await import('@noble/curves/bls12-381.js');
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!kommando || kommando === 'hjelp' || flagg.has('--help')) return bruk();

  if (kommando === 'verifiser') {
    const signatur = flagg.has('--signatur');
    if (signatur && !(await harSignaturPakke())) throw new Stopp('--signatur trenger pakken @noble/curves. Kjør npm install først.');
    const feil = await verifiser({ dir, slug, signatur });
    if (feil > 0) process.exitCode = 1;
    return;
  }

  if (kommando === 'status') return status({ db: await database(), dir, slug });

  if (!slug) {
    bruk();
    process.exitCode = 1;
    return;
  }

  if (kommando === 'rydd') return rydd({ privatDir, slug });

  if (kommando === 'frys') {
    const om = verdi('--om');
    const kl = verdi('--kl');
    if (om !== null && !/^\d+$/.test(om)) throw new Stopp('--om skal være et antall sekunder.');
    // A new rehearsal replaces the previous one.
    if (prove) await rm(join(privatDir, slug), { recursive: true, force: true });
    const out = await frys({
      prove,
      db: await database(),
      dir,
      privatDir,
      slug,
      omSekunder: om === null ? 30 : Number(om),
      klokka: kl ? lesKlokke(kl) : null,
      omtrekning: flagg.has('--omtrekning'),
    });
    console.log(`\nHjulet kan startes nå. Tallet fra drand kommer ${tid(out.forpliktelse.tilfeldighet.tidspunkt)}.`);
    console.log(`Etter at hjulet har snurret: node --env-file=<.env.local> vinn.mjs trekk ${slug}${prove ? ' --prove' : ''}`);
    return;
  }

  if (kommando === 'trekk') {
    const signatur = await harSignaturPakke();
    if (!signatur) console.log('Merk: @noble/curves er ikke installert, så drand-signaturen sjekkes ikke. Kjør npm install.');
    await trekk({ db: await database(), dir, privatDir, slug, vent: flagg.has('--vent'), signatur, prove });
    if (prove) return;
    console.log(`\nAlt om trekningen ligger i ${dir}/${slug}.`);
    console.log(`Slett navnene til hjulet når premien er sendt: node vinn.mjs rydd ${slug}`);
    return;
  }

  bruk();
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Stopp ? `\n${e.message}` : e);
  process.exitCode = 1;
});
