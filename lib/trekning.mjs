/**
 * The draw itself. Everything that decides who wins is in this one file.
 *
 * No dependencies and no secrets: the same input always gives the same
 * winner, on any machine. It only uses SHA-256 from Web Crypto, so it runs
 * unchanged in Node and in a browser.
 *
 * Input:
 *   1. the frozen list of tickets (lodd), locked before the draw
 *   2. a random value from drand that did not exist when the list was frozen
 *
 * Output: the winning ticket.
 */

export const ALGORITME = 'kaytomas-vinn-v1';

const LODD_PREFIKS = 'kaytomas-vinn-lodd-v1:';
const LODD_LENGDE = 12;

const encoder = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The ticket for one entry: the first 12 hex characters of a SHA-256 over the
 * entry's id in the database. The id is a random UUID that is never shown to
 * anyone but the participant, so a ticket cannot be traced back to a person.
 */
export async function lodd(entryId) {
  const id = String(entryId).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error(`Ugyldig påmeldings-id: ${entryId}`);
  }
  return hex(await sha256(LODD_PREFIKS + id)).slice(0, LODD_LENGDE);
}

/** "3f9ac21077be" -> "3f9a-c210-77be", for people to read. */
export function visLodd(ticket) {
  return String(ticket).replace(/(.{4})(?=.)/g, '$1-');
}

/** Sorted, and refuses duplicates and anything that is not a ticket. */
export function sorterLodd(tickets) {
  const sorted = [...tickets].sort();
  for (let i = 0; i < sorted.length; i++) {
    if (!/^[0-9a-f]{12}$/.test(sorted[i])) throw new Error(`Ugyldig lodd: ${sorted[i]}`);
    if (i > 0 && sorted[i] === sorted[i - 1]) throw new Error(`Samme lodd står to ganger: ${sorted[i]}`);
  }
  return sorted;
}

/** Fingerprint of the whole list: SHA-256 of the sorted tickets, one per line. */
export async function listehash(tickets) {
  return hex(await sha256(sorterLodd(tickets).join('\n')));
}

/** The tickets that are actually in the draw: the list minus earlier winners. */
export function pott(tickets, utelatt = []) {
  const sorted = sorterLodd(tickets);
  const out = new Set(utelatt);
  for (const ticket of out) {
    if (!sorted.includes(ticket)) throw new Error(`Utelatt lodd finnes ikke i lista: ${ticket}`);
  }
  return sorted.filter((ticket) => !out.has(ticket));
}

/**
 * Picks the winner.
 *
 * A SHA-256 over the giveaway, the draw number, the list fingerprint, the
 * excluded tickets and the drand value gives a 64-bit number. The number
 * picks a position in the sorted list. Numbers from the uneven top of the
 * range are thrown away and a new one is made (rejection sampling), so every
 * ticket has exactly the same chance.
 */
export async function velgVinner({ giveaway, trekning, lodd: tickets, utelatt = [], tilfeldighet }) {
  if (!/^[a-z0-9-]{3,80}$/.test(giveaway ?? '')) throw new Error('Ugyldig giveaway-slug.');
  if (!Number.isInteger(trekning) || trekning < 1) throw new Error('Ugyldig trekningsnummer.');
  if (!/^[0-9a-f]{64}$/.test(tilfeldighet ?? '')) throw new Error('Ugyldig tilfeldighet fra drand.');

  const pool = pott(tickets, utelatt);
  if (pool.length === 0) throw new Error('Ingen lodd å trekke blant.');

  const fingerprint = await listehash(tickets);
  const excluded = [...utelatt].sort().join(',');
  const n = BigInt(pool.length);
  const space = 2n ** 64n;
  const limit = space - (space % n);

  for (let forsok = 0; forsok < 1000; forsok++) {
    const melding = [ALGORITME, giveaway, trekning, fingerprint, excluded, tilfeldighet, forsok].join('|');
    const digest = await sha256(melding);
    const value = new DataView(digest.buffer).getBigUint64(0, false);
    if (value < limit) {
      const indeks = Number(value % n);
      return {
        vinner: pool[indeks],
        indeks,
        antall: pool.length,
        listehash: fingerprint,
        forsok,
        melding,
        sha256: hex(digest),
      };
    }
  }
  throw new Error('Fant ikke et gyldig tall etter 1000 forsøk.');
}
