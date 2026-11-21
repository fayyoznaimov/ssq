/**
 * Period bounds for the reports.
 *
 * The client sends plain dates (`YYYY-MM-DD`) for both ends of a period, so a
 * `BETWEEN from AND till` filter used to drop the whole last day (everything
 * after 00:00 of `till_date`) and "today" returned nothing. A plain end date is
 * stretched to the end of that day; a value with a time part is used as it is.
 */
export interface PeriodBounds {
  from_date: string;
  till_date: string;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function periodBounds(query: {
  from_date: Date | string;
  till_date: Date | string;
}): PeriodBounds {
  const from = String(query.from_date);
  const till = String(query.till_date);

  return {
    from_date: from,
    till_date: PLAIN_DATE.test(till) ? `${till} 23:59:59.999` : till,
  };
}
