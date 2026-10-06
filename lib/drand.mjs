/**
 * drand: the public source of randomness.
 *
 * drand (https://drand.love, https://github.com/drand/drand) is run by the
 * League of Entropy, a group of independent organisations. Every third second
 * the network publishes a new numbered round with a random value that nobody,
 * including the members, can know or steer in advance. Each round is signed,
 * and the signature can be checked against the network's public key below.
 *
 * We name a round in the future when the list is frozen. The winner is then
 * decided by a value that did not exist when the list was locked.
 */

export const KJEDE = {
  navn: 'drand quicknet',
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  offentligNokkel:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367,
  periode: 3,
};

/** Independent relays. All of them must agree. */
export const KILDER = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com',
];

const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

/** The first round published at or after the given time. */
export function rundeForTid(date) {
  const seconds = Math.ceil(new Date(date).getTime() / 1000);
  if (!Number.isFinite(seconds)) throw new Error('Ugyldig tidspunkt.');
  if (seconds <= KJEDE.genesis) return 1;
  return Math.ceil((seconds - KJEDE.genesis) / KJEDE.periode) + 1;
}

/** When a round is published. */
export function tidForRunde(runde) {
  return new Date((KJEDE.genesis + (runde - 1) * KJEDE.periode) * 1000);
}

export function rundeUrl(runde, kilde = KILDER[0]) {
  return `${kilde}/${KJEDE.hash}/public/${runde}`;
}

function hexToBytes(text) {
  if (!/^([0-9a-f]{2})+$/.test(text)) throw new Error('Ugyldig hex.');
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function rundeBytes(runde) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(runde), false);
  return bytes;
}

async function hentFra(kilde, runde, timeoutMs) {
  const res = await fetch(rundeUrl(runde, kilde), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.round !== runde) throw new Error(`fikk runde ${body.round}`);
  if (!/^[0-9a-f]{64}$/.test(body.randomness ?? '') || !/^[0-9a-f]{96}$/.test(body.signature ?? '')) {
    throw new Error('uventet svar');
  }
  return { runde, tilfeldighet: body.randomness, signatur: body.signature };
}

/**
 * Checks the signature of a round against the network's public key
 * (BLS12-381, signature in G1, as specified for quicknet). This is the proof
 * that the value really comes from drand. Needs the package @noble/curves.
 */
export async function sjekkSignatur({ runde, tilfeldighet, signatur }) {
  const { bls12_381 } = await import('@noble/curves/bls12-381.js');
  const sigs = bls12_381.shortSignatures;
  const melding = sigs.hash(await sha256(rundeBytes(runde)), DST);
  const gyldig = sigs.verify(hexToBytes(signatur), melding, hexToBytes(KJEDE.offentligNokkel));
  if (!gyldig) throw new Error(`Signaturen for runde ${runde} er ikke gyldig.`);
  if (bytesToHex(await sha256(hexToBytes(signatur))) !== tilfeldighet) {
    throw new Error(`Tilfeldigheten for runde ${runde} stemmer ikke med signaturen.`);
  }
  return true;
}

/**
 * Fetches one round from every relay. They must all give the same answer, at
 * least `minst` of them must answer, and the random value must be the SHA-256
 * of the signature. With `signatur: true` the signature is checked as well.
 */
export async function hentRunde(runde, { kilder = KILDER, minst = 2, signatur = false, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(runde) || runde < 1) throw new Error('Ugyldig rundenummer.');
  if (tidForRunde(runde).getTime() > Date.now()) {
    throw new Error(`Runde ${runde} er ikke publisert ennå (${tidForRunde(runde).toISOString()}).`);
  }

  const svar = await Promise.allSettled(kilder.map((kilde) => hentFra(kilde, runde, timeoutMs)));
  const ok = svar.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length < Math.min(minst, kilder.length)) {
    const feil = svar.map((s, i) => `${kilder[i]}: ${s.status === 'fulfilled' ? 'ok' : s.reason?.message}`);
    throw new Error(`For få drand-kilder svarte på runde ${runde}.\n  ${feil.join('\n  ')}`);
  }

  const first = ok[0];
  for (const other of ok) {
    if (other.tilfeldighet !== first.tilfeldighet || other.signatur !== first.signatur) {
      throw new Error(`drand-kildene er uenige om runde ${runde}. Ingenting er trukket.`);
    }
  }
  if (bytesToHex(await sha256(hexToBytes(first.signatur))) !== first.tilfeldighet) {
    throw new Error(`Tilfeldigheten for runde ${runde} stemmer ikke med signaturen.`);
  }
  if (signatur) await sjekkSignatur(first);

  return { ...first, kilderSomSvarte: ok.length, signaturSjekket: signatur };
}
