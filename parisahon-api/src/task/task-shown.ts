/**
 * Which tasks are shown (DB-11): a task disappears from the lists, the calendar, the desktop counters and the
 * bot's lists and reminders while what it is set on is in the trash — its deal; a task without a deal: its
 * company; without both: its contact. Nothing in the task changes, so restoring the deal, the company (which
 * brings its contacts back) or the contact brings the task back too. Tasks of deals in the trash were hidden
 * already; those of a deleted company or contact stayed in every list.
 * `t` is the alias of the task in the query.
 */
export function taskShownSql(t: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM deal ${t}_td WHERE ${t}_td.id = ${t}.deal_id AND ${t}_td.deleted_at IS NOT NULL)` +
    ` AND (${t}.deal_id IS NOT NULL OR NOT EXISTS` +
    ` (SELECT 1 FROM company ${t}_tc WHERE ${t}_tc.id = ${t}.company_id AND ${t}_tc.deleted_at IS NOT NULL))` +
    ` AND (${t}.deal_id IS NOT NULL OR ${t}.company_id IS NOT NULL OR NOT EXISTS` +
    ` (SELECT 1 FROM "user" ${t}_tu WHERE ${t}_tu.id = ${t}.ctr_agent_id AND ${t}_tu.deleted_at IS NOT NULL))`
  );
}
