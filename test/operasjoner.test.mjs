import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apneDatabase } from '../lib/database.mjs';
import { rundeForTid, tidForRunde } from '../lib/drand.mjs';
import { Stopp, frys, rydd, trekk, verifiser } from '../lib/operasjoner.mjs';
import { lodd } from '../lib/trekning.mjs';

const ID = (prefix, i) => `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const STENGT = '2026-10-18T19:00:00.000Z';
const stille = () => {};

/** A fake drand: every round has a fixed value, and future rounds do not exist. */
function falskDrand(klokke) {
  return async (runde) => {
    if (tidForRunde(runde).getTime() > klokke.na().getTime()) throw new Error('ikke publisert');
    return { runde, tilfeldighet: runde.toString(16).padStart(64, '0'), signatur: 'ab'.repeat(48), kilderSomSvarte: 4, signaturSjekket: false };
  };
}

async function oppsett(antall = 40) {
  const tmp = await mkdtemp(join(tmpdir(), 'vinn-test-'));
  const dbFil = join(tmp, 'db.json');
  const data = {
    giveaways: [{ id: 'g1', slug: 'demo-giveaway', tittel: 'Demo', frist: STENGT, trukket: null, seed: null, vinner: null }],
    deltakere: Array.from({ length: antall }, (_, i) => ({
      id: ID('b', i), navn: `Person${i} Etternavn`, epost: `p${i}@example.com`, telefon: '+4700000000', postnummer: '8000', poststed: 'BODØ',
    })),
    pameldinger: Array.from({ length: antall }, (_, i) => ({ id: ID('a', i), giveaway: 'g1', deltaker: ID('b', i) })),
  };
  await writeFile(dbFil, JSON.stringify(data));
  const klokke = { t: new Date('2026-10-18T19:00:30.000Z'), na() { return this.t; } };
  const felles = { db: await apneDatabase({ VINN_TESTDATA: dbFil }), dir: join(tmp, 'trekninger'), privatDir: join(tmp, 'privat'), slug: 'demo-giveaway', logg: stille, na: () => klokke.na() };
  return { tmp, dbFil, klokke, felles, hent: falskDrand(klokke), les: async () => JSON.parse(await readFile(dbFil, 'utf8')) };
}

test('lista kan ikke fryses mens påmeldingen er åpen', async () => {
  const o = await oppsett();
  o.klokke.t = new Date('2026-10-18T18:59:59.000Z');
  await assert.rejects(frys(o.felles), Stopp);
});

test('hele gangen: frys, trekk, verifiser', async () => {
  const o = await oppsett();
  const frosset = await frys(o.felles);
  const f = frosset.forpliktelse;
  assert.equal(f.antall, 40);
  assert.equal(f.tilfeldighet.runde, rundeForTid(new Date('2026-10-18T19:01:00.000Z')));
  assert.ok(!JSON.stringify(f).includes('Person'), 'den låste lista skal ikke inneholde navn');
  assert.ok(!JSON.stringify(f).includes(ID('a', 3)), 'den låste lista skal ikke inneholde id-er fra databasen');

  // Frozen twice: refused, nothing overwritten.
  await assert.rejects(frys(o.felles), Stopp);
  // The round is not out yet.
  await assert.rejects(trekk({ ...o.felles, hent: o.hent }), Stopp);
  assert.equal(await verifiser({ dir: o.felles.dir, hent: o.hent, logg: stille, na: o.felles.na }), 0);

  o.klokke.t = new Date('2026-10-18T19:11:00.000Z');
  const ut = await trekk({ ...o.felles, hent: o.hent });
  assert.equal(ut.lagret, true);
  assert.equal(ut.display.endsWith(', Bodø'), true);
  const db = await o.les();
  const vinnerEntry = db.pameldinger.find((e) => e.deltaker === db.giveaways[0].vinner);
  assert.equal(await lodd(vinnerEntry.id), ut.resultat.vinner.lodd);
  assert.match(db.giveaways[0].seed, /^drand-quicknet:\d+:[0-9a-f]{64}:trekning-1$/);

  // Running it again gives the same winner and changes nothing.
  const forst = db.giveaways[0].trukket;
  o.klokke.t = new Date('2026-10-18T19:20:00.000Z');
  const igjen = await trekk({ ...o.felles, hent: o.hent });
  assert.equal(igjen.resultat.vinner.lodd, ut.resultat.vinner.lodd);
  assert.equal((await o.les()).giveaways[0].trukket, forst);

  assert.equal(await verifiser({ dir: o.felles.dir, hent: o.hent, logg: stille, na: o.felles.na }), 0);
  // A second freeze without --omtrekning is refused.
  await assert.rejects(frys(o.felles), Stopp);
});

test('omtrekning utelater alle tidligere vinnere og bruker samme liste', async () => {
  const o = await oppsett(3);
  const vinnere = [];
  for (let n = 1; n <= 3; n++) {
    const frosset = await frys({ ...o.felles, omtrekning: n > 1 });
    assert.equal(frosset.forpliktelse.antall, 4 - n);
    assert.deepEqual(frosset.forpliktelse.utelatt, vinnere);
    o.klokke.t = new Date(o.klokke.t.getTime() + 11 * 60000);
    const ut = await trekk({ ...o.felles, hent: o.hent });
    assert.ok(!vinnere.includes(ut.resultat.vinner.lodd));
    vinnere.push(ut.resultat.vinner.lodd);
    assert.match((await o.les()).giveaways[0].seed, new RegExp(`trekning-${n}$`));
  }
  assert.equal(new Set(vinnere).size, 3);
  await assert.rejects(frys({ ...o.felles, omtrekning: true }), Stopp);
  assert.equal(await verifiser({ dir: o.felles.dir, hent: o.hent, logg: stille, na: o.felles.na }), 0);
});

test('verifiser oppdager en endret liste og et byttet vinnerlodd', async () => {
  const o = await oppsett();
  await frys(o.felles);
  o.klokke.t = new Date('2026-10-18T19:11:00.000Z');
  await trekk({ ...o.felles, hent: o.hent });
  const sjekk = () => verifiser({ dir: o.felles.dir, hent: o.hent, logg: stille, na: o.felles.na });
  assert.equal(await sjekk(), 0);

  const fFil = join(o.felles.dir, 'demo-giveaway', '1-forpliktelse.json');
  const rFil = join(o.felles.dir, 'demo-giveaway', '1-resultat.json');
  const f = await readFile(fFil, 'utf8');
  const r = await readFile(rFil, 'utf8');

  // One ticket removed from the list.
  const uten = JSON.parse(f);
  uten.lodd.pop();
  await writeFile(fFil, JSON.stringify(uten));
  assert.ok((await sjekk()) > 0);
  await writeFile(fFil, f);

  // Another winner written into the result.
  const byttet = JSON.parse(r);
  byttet.vinner.lodd = JSON.parse(f).lodd.find((l) => l !== byttet.vinner.lodd);
  await writeFile(rFil, JSON.stringify(byttet));
  assert.ok((await sjekk()) > 0);

  // Another drand round than the one that was announced.
  const annen = JSON.parse(f);
  annen.tilfeldighet.runde += 1;
  await writeFile(rFil, r);
  await writeFile(fFil, JSON.stringify(annen));
  assert.ok((await sjekk()) > 0);
});

test('vinneren lagres ikke når databasen har en ukjent trekning', async () => {
  const o = await oppsett();
  await frys(o.felles);
  const db = await o.les();
  db.giveaways[0].seed = 'noe-annet';
  await writeFile(o.dbFil, JSON.stringify(db));
  o.klokke.t = new Date('2026-10-18T19:11:00.000Z');
  await assert.rejects(trekk({ ...o.felles, hent: o.hent }), /IKKE lagret/);
  assert.equal((await o.les()).giveaways[0].vinner, null);
});

test('slettet vinnerkonto: resultatet står, ingenting lagres', async () => {
  const o = await oppsett(1);
  await frys(o.felles);
  const db = await o.les();
  db.deltakere = [];
  db.pameldinger = [];
  await writeFile(o.dbFil, JSON.stringify(db));
  o.klokke.t = new Date('2026-10-18T19:11:00.000Z');
  const ut = await trekk({ ...o.felles, hent: o.hent });
  assert.equal(ut.kontakt, null);
  assert.equal(ut.lagret, false);
});

test('rydd sletter navnene og beholder loggen', async () => {
  const o = await oppsett();
  // Same folder for the log and the names, as in real use.
  const felles = { ...o.felles, dir: o.felles.privatDir };
  await frys(felles);
  o.klokke.t = new Date('2026-10-18T19:11:00.000Z');
  await trekk({ ...felles, hent: o.hent });
  const mappe = join(felles.privatDir, 'demo-giveaway');
  assert.deepEqual((await readdir(mappe)).sort(), ['1-forpliktelse.json', '1-resultat.json', 'hjul-1.json']);
  await rydd({ privatDir: felles.privatDir, slug: 'demo-giveaway', logg: stille });
  assert.deepEqual((await readdir(mappe)).sort(), ['1-forpliktelse.json', '1-resultat.json']);
  assert.equal(await verifiser({ dir: felles.dir, hent: o.hent, logg: stille, na: felles.na }), 0);
});

test('en prøve lagrer ingenting og viser ingen kontaktinfo', async () => {
  const o = await oppsett();
  await frys({ ...o.felles, prove: true });
  o.klokke.t = new Date('2026-10-18T19:11:00.000Z');
  const linjer = [];
  const ut = await trekk({ ...o.felles, hent: o.hent, prove: true, logg: (l) => linjer.push(l) });
  assert.equal(ut.lagret, false);
  assert.equal(ut.kontakt, null);
  const db = await o.les();
  assert.equal(db.giveaways[0].vinner, null);
  assert.equal(db.giveaways[0].seed, null);
  assert.ok(!linjer.join('\n').includes('example.com'));
  assert.ok(!linjer.join('\n').includes('Person'));
});
