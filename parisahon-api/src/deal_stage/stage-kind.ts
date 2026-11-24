/**
 * What a stage means: deal_stage.kind (migration 1795620000000-deal-stage-kind). The name of a stage
 * is only its label and can be changed in «Настроить воронку»; the code asks for the kind.
 *
 * Every pipeline (collection) has one stage of each system kind (seed.service.ts creates a missing
 * one at start, the partial unique index IDX_deal_stage_collection_kind keeps it single):
 *  - new           «НЕРАЗОБРАННОЕ»: where a deal goes when nothing else fits (Telegram, WhatsApp,
 *                  calls, mail, the bot, when the stage for new deals is not usable);
 *  - first_contact «ПЕРВИЧНЫЙ КОНТАКТ»: the stage for new deals of a fresh database (seedSettings);
 *  - prepayment    «ПРЕДОПЛАТА»;
 *  - won           «УСПЕШНО РЕАЛИЗОВАНО»: closes the deal; goals, analytics, LTV and the desktop
 *                  count it as a sale;
 *  - lost          «ЗАКРЫТО И НЕ РЕАЛИЗОВАНО»: closes the deal, not a sale.
 * Any stage added by an admin is `work`. A system stage cannot be deleted or moved to another
 * pipeline; it can be renamed.
 *
 * DEAL_STAGE_* of .env (DEAL_STAGE_UNKNOWN, _CREATED, _PREPAYMENT, _CLOSED, _CLOSED_NOT_REALIZED)
 * are now only the default names of the system stages of a new pipeline and, for one release, a
 * fallback: at start a stage of kind `work` that bears such a name gets the kind when its pipeline
 * has no stage of that kind yet (SeedService.seedStages). They decide nothing else.
 */
export enum StageKind {
  NEW = 'new',
  FIRST_CONTACT = 'first_contact',
  PREPAYMENT = 'prepayment',
  WON = 'won',
  LOST = 'lost',
  WORK = 'work',
}

/** The system stages of a pipeline, in the order a new pipeline gets them. */
export const SYSTEM_STAGE_KINDS: StageKind[] = [
  StageKind.NEW,
  StageKind.FIRST_CONTACT,
  StageKind.WON,
  StageKind.LOST,
  StageKind.PREPAYMENT,
];

/** A deal in a stage of these kinds is closed (deal.closed_at is set). */
export const CLOSING_STAGE_KINDS: StageKind[] = [StageKind.WON, StageKind.LOST];

const DEFAULT_NAMES: Record<string, { env: string; name: string }> = {
  [StageKind.NEW]: { env: 'DEAL_STAGE_UNKNOWN', name: 'НЕРАЗОБРАННОЕ' },
  [StageKind.FIRST_CONTACT]: { env: 'DEAL_STAGE_CREATED', name: 'ПЕРВИЧНЫЙ КОНТАКТ' },
  [StageKind.PREPAYMENT]: { env: 'DEAL_STAGE_PREPAYMENT', name: 'ПРЕДОПЛАТА' },
  [StageKind.WON]: { env: 'DEAL_STAGE_CLOSED', name: 'УСПЕШНО РЕАЛИЗОВАНО' },
  [StageKind.LOST]: { env: 'DEAL_STAGE_CLOSED_NOT_REALIZED', name: 'ЗАКРЫТО И НЕ РЕАЛИЗОВАНО' },
};

/** The name a new system stage gets (DEAL_STAGE_* of .env, otherwise the usual Russian name). */
export function defaultStageName(kind: StageKind): string {
  const entry = DEFAULT_NAMES[kind];
  if (!entry) return '';
  return (process.env[entry.env] || '').trim() || entry.name;
}

/** The kind a stage of the old naming had (only for the one-release fallback of the seed). */
export function legacyKindOfName(name: string | null | undefined): StageKind | null {
  if (!name) return null;
  for (const kind of SYSTEM_STAGE_KINDS) {
    if (defaultStageName(kind) === name) return kind;
  }
  return null;
}

type WithKind = { kind?: string | null } | null | undefined;

export function stageKindOf(stage: WithKind): StageKind | null {
  return (stage?.kind as StageKind) ?? null;
}

export function isWonStage(stage: WithKind): boolean {
  return stageKindOf(stage) === StageKind.WON;
}

export function isLostStage(stage: WithKind): boolean {
  return stageKindOf(stage) === StageKind.LOST;
}

/** «успешно реализовано» or «закрыто и не реализовано»: the deal is closed in it. */
export function isClosingStage(stage: WithKind): boolean {
  return CLOSING_STAGE_KINDS.includes(stageKindOf(stage) as StageKind);
}

/** A stage every pipeline must have: not deleted, not moved to another pipeline. */
export function isSystemStage(stage: WithKind): boolean {
  const kind = stageKindOf(stage);
  return !!kind && kind !== StageKind.WORK;
}

/**
 * SQL condition "the stage `alias` is of one of these kinds" (`alias`.kind of a deal_stage row).
 * The kinds are the constants above, never user input, so they are written into the SQL.
 */
export function stageKindSql(alias: string, kinds: StageKind[]): string {
  if (kinds.length === 0) return 'FALSE';
  return `${alias}.kind IN (${kinds.map((kind) => `'${kind}'`).join(', ')})`;
}
