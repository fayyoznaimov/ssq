import { ValueTransformer } from 'typeorm';

/**
 * A numeric amount as text without trailing zeros: "12.500" -> "12.5", "16500000.00" -> "16500000".
 * deal.budget, deal_product.quantity and price are numeric (migration 1795620000100): Postgres gives
 * them as text, and the API keeps giving text, as it did for the old bigint columns, so the web
 * client, the history ("10" -> "12.5") and the comparisons of the deal form see the same values.
 */
export function canonicalDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text.includes('.') || /e/i.test(text)) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/** numeric column <-> canonical text (canonicalDecimal); a number written by the code goes as it is. */
export const decimalText: ValueTransformer = {
  to: (value: number | string | null | undefined) => value,
  from: (value: string | null) => canonicalDecimal(value),
};
