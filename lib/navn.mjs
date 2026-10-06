/**
 * What the wheel and the winner line show: first name and town, nothing else.
 * "ola nordmann hansen" + "TROMSØ" -> "Ola, Tromsø".
 */

function storForbokstav(text) {
  return text.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}

export function visningsnavn(fullName, city) {
  const first = (fullName ?? '').trim().split(/\s+/).filter(Boolean)[0];
  const name = first ? storForbokstav(first) : 'Ukjent';
  const town = (city ?? '').trim();
  return town ? `${name}, ${storForbokstav(town)}` : name;
}
