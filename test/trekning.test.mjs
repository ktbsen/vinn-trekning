import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rundeForTid, tidForRunde } from '../lib/drand.mjs';
import { visningsnavn } from '../lib/navn.mjs';
import { listehash, lodd, pott, sorterLodd, velgVinner, visLodd } from '../lib/trekning.mjs';

const ID = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const R = (i) => i.toString(16).padStart(64, '0');

test('lodd er stabilt, og likt uansett store og små bokstaver', async () => {
  // Fixed vector: api/vinn/me.ts in the website must give the same ticket.
  assert.equal(await lodd('00000000-0000-4000-8000-000000000001'), '78e0b799834e');
  assert.equal(await lodd('ABCDEF00-0000-4000-8000-000000000001'), await lodd('abcdef00-0000-4000-8000-000000000001'));
  assert.equal(visLodd('3f9ac21077be'), '3f9a-c210-77be');
  await assert.rejects(lodd('ikke-en-uuid'));
});

test('lista sorteres, og duplikater og søppel avvises', () => {
  assert.deepEqual(sorterLodd(['bbbbbbbbbbbb', 'aaaaaaaaaaaa']), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.throws(() => sorterLodd(['aaaaaaaaaaaa', 'aaaaaaaaaaaa']));
  assert.throws(() => sorterLodd(['Ola, Tromsø']));
});

test('fingeravtrykket er likt uansett rekkefølge, og endres av ett lodd', async () => {
  const a = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'];
  assert.equal(await listehash(a), await listehash([...a].reverse()));
  assert.notEqual(await listehash(a), await listehash([...a, 'dddddddddddd']));
});

test('samme inndata gir alltid samme vinner', async () => {
  const tickets = await Promise.all(Array.from({ length: 50 }, (_, i) => lodd(ID(i))));
  const input = { giveaway: 'demo-giveaway', trekning: 1, lodd: tickets, tilfeldighet: R(12345) };
  const a = await velgVinner(input);
  const b = await velgVinner({ ...input, lodd: [...tickets].reverse() });
  assert.equal(a.vinner, b.vinner);
  assert.equal(a.vinner, sorterLodd(tickets)[a.indeks]);
  assert.equal(a.antall, 50);
  // Any change to the input changes the message that is hashed.
  assert.notEqual(a.melding, (await velgVinner({ ...input, trekning: 2 })).melding);
  assert.notEqual(a.melding, (await velgVinner({ ...input, giveaway: 'annen-giveaway' })).melding);
});

test('utelatte lodd kan ikke vinne', async () => {
  const tickets = await Promise.all(Array.from({ length: 5 }, (_, i) => lodd(ID(i))));
  const utelatt = sorterLodd(tickets).slice(0, 4);
  assert.deepEqual(pott(tickets, utelatt), [sorterLodd(tickets)[4]]);
  for (let i = 0; i < 20; i++) {
    const r = await velgVinner({ giveaway: 'demo-giveaway', trekning: 2, lodd: tickets, utelatt, tilfeldighet: R(i) });
    assert.equal(r.vinner, sorterLodd(tickets)[4]);
  }
  assert.throws(() => pott(tickets, ['ffffffffffff']));
});

test('alle lodd har lik sjanse', async () => {
  const n = 7;
  const tickets = await Promise.all(Array.from({ length: n }, (_, i) => lodd(ID(i))));
  const counts = new Array(n).fill(0);
  const draws = 14000;
  for (let i = 0; i < draws; i++) {
    counts[(await velgVinner({ giveaway: 'demo-giveaway', trekning: 1, lodd: tickets, tilfeldighet: R(i) })).indeks]++;
  }
  // Expected 2000 each. Chi-square with 6 degrees of freedom: 22.46 is p = 0.001.
  const chi = counts.reduce((sum, c) => sum + (c - draws / n) ** 2 / (draws / n), 0);
  assert.ok(chi < 22.46, `skjev fordeling: ${counts.join(', ')}`);
});

test('ugyldig inndata avvises', async () => {
  const tickets = [await lodd(ID(1))];
  await assert.rejects(velgVinner({ giveaway: 'demo-giveaway', trekning: 1, lodd: tickets, tilfeldighet: 'abc' }));
  await assert.rejects(velgVinner({ giveaway: 'demo-giveaway', trekning: 0, lodd: tickets, tilfeldighet: R(1) }));
  await assert.rejects(velgVinner({ giveaway: 'demo-giveaway', trekning: 1, lodd: [], tilfeldighet: R(1) }));
});

test('drand-runder og tidspunkt henger sammen', () => {
  const runde = 32823221;
  assert.equal(tidForRunde(runde).toISOString(), '2026-10-06T07:50:27.000Z');
  assert.equal(rundeForTid(tidForRunde(runde)), runde);
  assert.equal(rundeForTid(new Date(tidForRunde(runde).getTime() + 1)), runde + 1);
  assert.equal(rundeForTid(new Date(tidForRunde(runde).getTime() - 1)), runde);
});

test('visningsnavn er fornavn og poststed', () => {
  assert.equal(visningsnavn('ola nordmann hansen', 'TROMSØ'), 'Ola, Tromsø');
  assert.equal(visningsnavn('Anne-lise Berg', 'mo i rana'), 'Anne-Lise, Mo I Rana');
  assert.equal(visningsnavn('Kari', ''), 'Kari');
  assert.equal(visningsnavn(null, 'Bodø'), 'Ukjent, Bodø');
});
