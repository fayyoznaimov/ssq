/**
 * «Рынок»: which of our products a client's words are about. Words of a product name, a size ("70x140" in any
 * writing: 70х140, 70×140, 70*140, «70 на 140») and a grammage ("500", "500 г/м²", "500гр"), compared as sets;
 * a number counts double (the size or the grammage decides more than a common word).
 */
export function tokens(...parts: (string | null | undefined)[]): Set<string> {
  const text = parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d+)\s*[xх×*]\s*(\d+)/gu, '$1x$2')
    .replace(/(\d+)\s+на\s+(\d+)/gu, '$1x$2')
    .replace(/(\d+)\s*(г\/м²|г\/м2|гр\/м2|гр|г|gsm)(?!\p{L})/gu, '$1');
  const out = new Set<string>();
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!word || word.length < 2) continue;
    // a Russian word without its ending: «полотенца» and «полотенце» match
    out.add(/^\p{L}+$/u.test(word) && word.length > 5 ? word.slice(0, word.length - 2) : word);
  }
  return out;
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += /\d/.test(t) ? 2 : 1;
  return n;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Two decimals; null stays null. */
export const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * A reported price in our currency (AI_MARKET_CURRENCY): the same currency or none as it is; another one through
 * the rates ("USD=12800": how much of our currency one unit costs; our own may be quoted too); null when there is
 * no rate (not compared).
 */
export function inCurrency(price: number | null, currency: string | null, ours: string, rates: Record<string, number>): number | null {
  if (price === null) return null;
  if (!currency || currency === ours) return price;
  if (!rates[currency]) return null;
  return (price * rates[currency]) / (rates[ours] ?? 1);
}
