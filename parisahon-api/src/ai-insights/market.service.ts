import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { AI, AiPriority } from '../ai/ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiPausedError, AiQueueService, sha256 } from '../ai/ai-queue.service';
import { CHAT_EVENT_TYPES, loadDeal, messagesByIds } from '../ai/ai-conversation';
import { FLAG_LABELS } from '../ai/ai-prompts';
import { loadStaffUser } from '../bot/bot-access';
import { AI2, PROMPT_VERSION_2, dayStart, localDay, testPrefixSql } from './ai-insights.config';
import { HourlyLimit, dealScopeSql } from './insights-common';
import { inCurrency, median, overlap, round, tokens } from './market-match';
import {
  MARKET_KINDS,
  MARKET_SUMMARY_SYSTEM,
  MARKET_SYSTEM,
  MarketOffer,
  MarketSummary,
  cleanMarket,
  cleanMarketSummary,
  looksLikeMarket,
  looksLikeMarketSummary,
  marketPrompt,
  marketSummaryPrompt,
} from './insights-prompts';

/** GET /ai/market, POST /ai/market/summary */
export interface MarketQuery {
  from_date?: string;
  till_date?: string;
  /** words of a product, size or grammage ("70x140", "халат") */
  product?: string;
  /** a product of the catalogue */
  product_id?: number;
  country?: string;
}

export interface MarketSummaryState {
  status: 'none' | 'stale' | 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'empty';
  fresh: boolean;
  cached?: boolean;
  job_id: number | null;
  made_at: Date | null;
  data: MarketSummary | null;
  error: string | null;
}

const MARKET_FLAGS = ['competitor', 'price_objection', 'discount'];
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface CatalogueProduct {
  id: number;
  name: string;
  unit: string | null;
  price: number | null;
  tokens: Set<string>;
}

/**
 * «Сравнение с рынком»: what clients say about the market, from the CRM only (no internet).
 *  - Collected: the turns the AI core analysed (conversation_turn) with the flag competitor, price_objection or
 *    discount, or with a target price, are read once more (job "market", background, priority of a nightly
 *    batch, within AI_DAILY_BUDGET): the client's words about other suppliers' offers — price, MOQ, delivery
 *    time, quality, payment terms, the supplier or country — and the price the client wants, each with the
 *    quote it comes from (market_mention).
 *  - Shown (GET /ai/market): per product — our price (the price list, the prices in deals) against the prices
 *    clients report from competitors, with the quotes, the deals and the dates; the signals of the turns
 *    («дорого», «просит скидку», «конкурент») with the client's words. Filters: period, product, country.
 *  - The AI summary «где мы дороже / дешевле и что говорят клиенты» on demand (POST /ai/market/summary): a
 *    person's request like the deal summary — cached for the same data, AI_INTERACTIVE_PER_HOUR, 503 during the pause.
 * Rights: only the deals the user may see (Access); letters only with the "mail" right; the summary is made
 * from that same data only.
 */
@Injectable()
export class AiMarketService implements OnModuleInit {
  private readonly logger = new Logger('AiMarket');
  private readonly limit = new HourlyLimit('сводка рынка');

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
  ) {}

  onModuleInit(): void {
    this.queue.register('market', (job) => this.run(job));
    this.queue.register('market_summary', (job) => this.runSummary(job));
    this.queue.addTicker('market detector', () => this.detect());
  }

  // ------------------------------------------------------------------ collection

  /** Turns with a market signal of the last AI_MARKET_DAYS not read for the market yet (no job "market"). */
  async detect(): Promise<number> {
    if (!AI2.market) return 0;
    const params: unknown[] = [AI2.marketDays, MARKET_FLAGS, CHAT_EVENT_TYPES];
    const prefix = testPrefixSql(params, 'd');
    const turns: { id: number; deal_id: number; ids: number[] }[] = await this.dataSource.query(
      `SELECT t.id, t.deal_id,
              ARRAY(SELECT e.id FROM event e
                     WHERE e.deal_id = t.deal_id AND e.type = ANY($3)
                       AND e.created_at >= (SELECT f.created_at FROM event f WHERE f.id = t.from_event_id)
                       AND e.created_at <= (SELECT l.created_at FROM event l WHERE l.id = t.to_event_id)
                     ORDER BY e.created_at, e.id LIMIT 40) AS ids
         FROM conversation_turn t
         JOIN deal d ON d.id = t.deal_id AND d.deleted_at IS NULL ${prefix}
        WHERE t.created_at > now() - make_interval(days => $1::int)
          AND (COALESCE(t.flags, '[]'::jsonb) ?| $2::text[] OR NULLIF(btrim(t.order_params->>'target_price'), '') IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM ai_job j WHERE j.kind = 'market' AND j.entity = 'turn' AND j.entity_id = t.id)
        ORDER BY t.id LIMIT 20`,
      params,
    );
    let queued = 0;
    for (const turn of turns) {
      const ids = [...new Set((turn.ids ?? []).map(Number))];
      try {
        const { created } = await this.queue.enqueue({
          kind: 'market',
          entity: 'turn',
          entityId: Number(turn.id),
          inputHash: sha256({ v: PROMPT_VERSION_2.market, turn: Number(turn.id), events: ids }),
          input: { turn_id: Number(turn.id), deal_id: Number(turn.deal_id), event_ids: ids },
          priority: AiPriority.NIGHTLY,
          promptVersion: PROMPT_VERSION_2.market,
        });
        if (created) queued++;
      } catch (error) {
        this.logger.warn(`turn ${turn.id}: ${(error as Error).message}`);
      }
    }
    return queued;
  }

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const turnId = job.entity_id;
    const [turn] = await this.dataSource.query(
      `SELECT t.id, t.deal_id FROM conversation_turn t JOIN deal d ON d.id = t.deal_id AND d.deleted_at IS NULL WHERE t.id = $1`,
      [turnId],
    );
    if (!turn) return { skipped: 'разбор хода или сделка удалены' };
    const dealId = Number(turn.deal_id);
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) return { skipped: 'сделка удалена' };
    const messages = await messagesByIds(this.dataSource, dealId, job.input?.event_ids ?? [], 1500);
    if (!messages.some((m) => m.from === 'client')) return { skipped: 'в ходе нет сообщений клиента' };
    const raw = await this.queue.askJson(job, MARKET_SYSTEM, marketPrompt({ now: new Date(), deal, messages }));
    if (!looksLikeMarket(raw)) throw new AiFormatError('ИИ ответил не по формату «Рынок»');
    const offers = cleanMarket(raw, messages);
    const at = new Map(messages.map((m) => [m.id, m]));
    await this.dataSource.transaction(async (m) => {
      await m.query(`DELETE FROM market_mention WHERE turn_id = $1`, [turnId]);
      for (const o of offers) {
        const message = at.get(o.event_id);
        await m.query(
          `INSERT INTO market_mention (deal_id, turn_id, job_id, event_id, kind, supplier, country, product, size, grammage, price, currency,
                                       unit, price_text, moq, delivery, quality, payment, quote, has_email, mentioned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
          [
            dealId,
            turnId,
            job.id,
            o.event_id,
            o.kind,
            o.supplier,
            o.country,
            o.product,
            o.size,
            o.grammage,
            o.price,
            o.currency,
            o.unit,
            o.price_text,
            o.moq,
            o.delivery,
            o.quality,
            o.payment,
            o.quote,
            message?.channel === 'email',
            message?.at ?? new Date(),
          ],
        );
      }
    });
    return { result: { offers: offers.length } };
  }

  // ------------------------------------------------------------------ the report

  private static period(q: MarketQuery): { from: Date; till: Date; label: string } {
    const now = new Date();
    const from = q.from_date && PLAIN_DAY.test(q.from_date) ? dayStart(q.from_date) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89);
    const last = q.till_date && PLAIN_DAY.test(q.till_date) ? dayStart(q.till_date) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const till = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    return { from, till, label: `${localDay(from)} — ${localDay(last)}` };
  }

  /** Our price in AI_MARKET_CURRENCY of a reported price, or null when it cannot be compared. */
  private static inOurCurrency(price: number | null, currency: string | null): number | null {
    return inCurrency(price, currency, AI2.marketCurrency, AI2.marketRates);
  }

  async report(user: AuthUser, q: MarketQuery): Promise<Record<string, any>> {
    const features = { market: AI2.market, enabled: AI.enabled };
    if (!AI2.market) return { enabled: false, features, groups: [], mentions: [], voices: [], counts: {}, options: { countries: [], products: [] }, summary: null };
    const data = await this.collect(user, q);
    const summary = await this.summaryView(user, q, data);
    return { enabled: true, features, ...this.publicView(data), summary };
  }

  /** The rows of the report the user may see. */
  private async collect(user: AuthUser, q: MarketQuery) {
    const access = new Access(user);
    const withMail = access.canReadMail;
    const period = AiMarketService.period(q);
    const product = (q.product ?? '').trim().slice(0, 100);
    const country = (q.country ?? '').trim().slice(0, 64);
    const productId = Number.isInteger(Number(q.product_id)) && Number(q.product_id) > 0 ? Number(q.product_id) : null;

    // ---- the mentions
    const params: unknown[] = [period.from, period.till, withMail];
    const scope = dealScopeSql(access, params, 'd');
    const where = [`m.mentioned_at >= $1`, `m.mentioned_at < $2`, `($3::boolean OR NOT m.has_email)`, scope];
    if (product) {
      params.push(`%${product.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const p = `$${params.length}`;
      where.push(`(m.product ILIKE ${p} OR m.size ILIKE ${p} OR m.grammage ILIKE ${p}
                   OR EXISTS (SELECT 1 FROM deal_product fdp JOIN product fp ON fp.id = fdp.product_id
                               WHERE fdp.deal_id = d.id AND fp.name ILIKE ${p}))`);
    }
    if (productId) {
      params.push(productId);
      where.push(`EXISTS (SELECT 1 FROM deal_product fdp WHERE fdp.deal_id = d.id AND fdp.product_id = $${params.length})`);
    }
    if (country) {
      params.push(`%${country.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const p = `$${params.length}`;
      where.push(`(m.country ILIKE ${p} OR EXISTS (SELECT 1 FROM deal_inbound fi WHERE fi.deal_id = d.id AND fi.country ILIKE ${p}))`);
    }
    const mentions: any[] = await this.dataSource.query(
      `SELECT m.id, m.deal_id, m.turn_id, m.event_id, m.kind, m.supplier, m.country, m.product, m.size, m.grammage, m.price::float AS price,
              m.currency, m.unit, m.price_text, m.moq, m.delivery, m.quality, m.payment, m.quote, m.has_email, m.mentioned_at,
              d.display_id, d.label AS deal_label, c.name AS company, a.username AS agent
         FROM market_mention m
         JOIN deal d ON d.id = m.deal_id AND d.deleted_at IS NULL
         LEFT JOIN company c ON c.id = d.company_id
         LEFT JOIN "user" a ON a.id = d.agent_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.mentioned_at DESC, m.id DESC LIMIT 500`,
      params,
    );

    // ---- the signals of the turns (the AI core's flags and target prices), with the client's words
    const vParams: unknown[] = [period.from, period.till, withMail, MARKET_FLAGS, CHAT_EVENT_TYPES];
    const vScope = dealScopeSql(access, vParams, 'd');
    const vWhere = [`t.created_at >= $1`, `t.created_at < $2`, `($3::boolean OR NOT t.has_email)`, vScope];
    if (product) {
      vParams.push(`%${product.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const p = `$${vParams.length}`;
      vWhere.push(`(t.order_params->>'product' ILIKE ${p} OR t.order_params->>'size' ILIKE ${p} OR t.order_params->>'grammage' ILIKE ${p}
                    OR EXISTS (SELECT 1 FROM deal_product fdp JOIN product fp ON fp.id = fdp.product_id WHERE fdp.deal_id = d.id AND fp.name ILIKE ${p}))`);
    }
    if (productId) {
      vParams.push(productId);
      vWhere.push(`EXISTS (SELECT 1 FROM deal_product fdp WHERE fdp.deal_id = d.id AND fdp.product_id = $${vParams.length})`);
    }
    if (country) {
      vParams.push(`%${country.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const p = `$${vParams.length}`;
      vWhere.push(`(t.order_params->>'country' ILIKE ${p} OR EXISTS (SELECT 1 FROM deal_inbound fi WHERE fi.deal_id = d.id AND fi.country ILIKE ${p}))`);
    }
    const voices: any[] = await this.dataSource.query(
      `SELECT t.id, t.deal_id, t.created_at, t.summary, t.has_email,
              ARRAY(SELECT f FROM jsonb_array_elements_text(COALESCE(t.flags, '[]'::jsonb)) f WHERE f = ANY($4)) AS flags,
              NULLIF(btrim(t.order_params->>'target_price'), '') AS target_price,
              NULLIF(btrim(t.order_params->>'product'), '') AS product, NULLIF(btrim(t.order_params->>'size'), '') AS size,
              NULLIF(btrim(t.order_params->>'grammage'), '') AS grammage,
              d.display_id, d.label AS deal_label, q.id AS quote_event_id, q.text AS quote
         FROM conversation_turn t
         JOIN deal d ON d.id = t.deal_id AND d.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT e.id, LEFT(btrim(COALESCE(NULLIF(e.after_state->>'message', ''), NULLIF(e.after_state->>'text', ''),
                                            e.after_state->'data'->>'subject', '')), 300) AS text
             FROM event e
            WHERE e.deal_id = t.deal_id AND e.type = ANY($5) AND NOT e.outgoing AND e.id BETWEEN t.from_event_id AND t.to_event_id
            ORDER BY e.created_at, e.id LIMIT 1
         ) q ON TRUE
        WHERE ${vWhere.join(' AND ')}
          AND (COALESCE(t.flags, '[]'::jsonb) ?| $4::text[] OR NULLIF(btrim(t.order_params->>'target_price'), '') IS NOT NULL)
        ORDER BY t.created_at DESC, t.id DESC LIMIT 200`,
      vParams,
    );

    // ---- our prices: the products of these deals, the catalogue, the prices in the deals of the last year
    const dealIds = [...new Set([...mentions.map((m) => Number(m.deal_id)), ...voices.map((v) => Number(v.deal_id))])];
    const dealProducts: { deal_id: number; product_id: number; price: number }[] = dealIds.length
      ? await this.dataSource.query(
          `SELECT dp.deal_id, dp.product_id, dp.price::float AS price FROM deal_product dp WHERE dp.deal_id = ANY($1) ORDER BY dp.id`,
          [dealIds],
        )
      : [];
    const catalogue: CatalogueProduct[] = (
      await this.dataSource.query(`SELECT id, name, unit, price::float AS price FROM product WHERE deleted_at IS NULL ORDER BY id LIMIT 2000`)
    ).map((p: any) => ({ id: Number(p.id), name: p.name, unit: p.unit ?? null, price: p.price === null ? null : Number(p.price), tokens: tokens(p.name) }));
    const byId = new Map(catalogue.map((p) => [p.id, p]));

    // what each mention is about: a product of its deal (the best match of the words; the only one), else of the catalogue
    const matched = new Map<number, CatalogueProduct | null>();
    for (const m of mentions) {
      const words = tokens(m.product, m.size, m.grammage);
      const own = dealProducts.filter((dp) => Number(dp.deal_id) === Number(m.deal_id)).map((dp) => byId.get(Number(dp.product_id))).filter(Boolean) as CatalogueProduct[];
      let best: CatalogueProduct | null = null;
      let bestScore = 0;
      for (const p of own) {
        const score = overlap(words, p.tokens);
        if (score > bestScore) [best, bestScore] = [p, score];
      }
      // the deal's only product, unless the client named another thing (a price alone is about the deal's product)
      const named = tokens(m.product);
      if (!best && own.length === 1 && (!named.size || overlap(named, own[0].tokens) > 0)) best = own[0];
      if (!best && words.size) {
        for (const p of catalogue) {
          const score = overlap(words, p.tokens);
          // a catalogue product only on a clear match: the size or grammage and a word of the name
          if (score >= 3 && score > bestScore) [best, bestScore] = [p, score];
        }
      }
      matched.set(Number(m.id), best);
    }

    const productIds = [...new Set([...matched.values()].filter(Boolean).map((p) => p!.id))];
    const pParams: unknown[] = [productIds, period.till];
    const pScope = dealScopeSql(access, pParams, 'd');
    const dealPrices: { product_id: number; n: number; avg: number; min: number; max: number }[] = productIds.length
      ? await this.dataSource.query(
          `SELECT dp.product_id, count(*)::int AS n, avg(dp.price)::float AS avg, min(dp.price)::float AS min, max(dp.price)::float AS max
             FROM deal_product dp JOIN deal d ON d.id = dp.deal_id AND d.deleted_at IS NULL
            WHERE dp.product_id = ANY($1) AND dp.price > 0 AND d.created_at >= $2::timestamp - interval '365 days' AND d.created_at < $2
              AND ${pScope}
            GROUP BY dp.product_id`,
          pParams,
        )
      : [];
    const priceOf = new Map(dealPrices.map((r) => [Number(r.product_id), r]));
    const ourPriceInDeal = (dealId: number, productIdOf: number) =>
      dealProducts.find((dp) => Number(dp.deal_id) === dealId && Number(dp.product_id) === productIdOf && Number(dp.price) > 0)?.price ?? null;

    // ---- the rows
    const rows = mentions.map((m) => {
      const ours = matched.get(Number(m.id)) ?? null;
      const theirs = AiMarketService.inOurCurrency(m.price === null ? null : Number(m.price), m.currency);
      const ourInDeal = ours ? ourPriceInDeal(Number(m.deal_id), ours.id) : null;
      const ourRef = ourInDeal ?? (ours ? priceOf.get(ours.id)?.avg ?? ours.price : null);
      const unitsDiffer = !!(ours?.unit && m.unit && ours.unit.toLowerCase().replace(/\.$/, '') !== String(m.unit).toLowerCase().replace(/\.$/, ''));
      const diff = m.kind !== 'our' && theirs !== null && ourRef && !unitsDiffer ? Math.round(((theirs - ourRef) / ourRef) * 1000) / 10 : null;
      return {
        id: Number(m.id),
        at: m.mentioned_at,
        kind: m.kind,
        kind_label: MARKET_KINDS[m.kind as keyof typeof MARKET_KINDS] ?? m.kind,
        deal: { id: Number(m.deal_id), number: m.display_id === null ? null : Number(m.display_id), label: m.deal_label },
        company: m.company ?? null,
        agent: m.agent ?? null,
        supplier: m.supplier,
        country: m.country,
        product: m.product,
        size: m.size,
        grammage: m.grammage,
        price: m.price === null ? null : Number(m.price),
        currency: m.currency,
        unit: m.unit,
        price_text: m.price_text,
        price_ours: round(theirs),
        moq: m.moq,
        delivery: m.delivery,
        quality: m.quality,
        payment: m.payment,
        quote: m.quote,
        event_id: m.event_id === null ? null : Number(m.event_id),
        has_email: !!m.has_email,
        our_product: ours ? { id: ours.id, name: ours.name, unit: ours.unit } : null,
        our_price: round(ourRef),
        our_price_source: ourInDeal !== null ? 'deal' : ours && priceOf.get(ours.id) ? 'deals' : ours?.price ? 'catalogue' : null,
        diff_pct: diff,
      };
    });

    // ---- the groups: our product, else the words of the mention
    const groups = new Map<string, any>();
    for (const r of rows) {
      const key = r.our_product ? `p${r.our_product.id}` : `t:${[...tokens(r.product, r.size, r.grammage)].sort().join(' ') || '—'}`;
      let g = groups.get(key);
      if (!g) {
        const p = r.our_product ? byId.get(r.our_product.id) ?? null : null;
        const deals = p ? priceOf.get(p.id) : undefined;
        g = {
          key,
          product_id: p?.id ?? null,
          name: p?.name ?? ([r.product, r.size, r.grammage ? `${r.grammage} г/м²` : null].filter(Boolean).join(' ') || 'Без названия товара'),
          unit: p?.unit ?? r.unit ?? null,
          catalogue: p?.price ?? null,
          deals_avg: deals ? round(deals.avg) : null,
          deals_min: deals ? round(deals.min) : null,
          deals_max: deals ? round(deals.max) : null,
          deals_n: deals?.n ?? 0,
          competitor: [] as number[],
          targets: [] as number[],
          our_quoted: [] as number[],
          mentions: 0,
          not_compared: 0,
          suppliers: new Set<string>(),
          countries: new Set<string>(),
          last_at: r.at,
        };
        groups.set(key, g);
      }
      g.mentions++;
      if (r.supplier) g.suppliers.add(r.supplier);
      if (r.country) g.countries.add(r.country);
      if (r.price_ours === null) {
        if (r.price !== null) g.not_compared++;
      } else if (r.kind === 'competitor') g.competitor.push(r.price_ours);
      else if (r.kind === 'client_target') g.targets.push(r.price_ours);
      else if (r.kind === 'our') g.our_quoted.push(r.price_ours);
    }
    const groupRows = [...groups.values()]
      .map((g) => {
        const marketMedian = median(g.competitor);
        const ourRef = g.deals_avg ?? g.catalogue ?? median(g.our_quoted);
        return {
          key: g.key,
          product_id: g.product_id,
          name: g.name,
          unit: g.unit,
          catalogue: g.catalogue,
          deals_avg: g.deals_avg,
          deals_min: g.deals_min,
          deals_max: g.deals_max,
          deals_n: g.deals_n,
          our_quoted: round(median(g.our_quoted)),
          market_n: g.competitor.length,
          market_min: g.competitor.length ? round(Math.min(...g.competitor)) : null,
          market_median: round(marketMedian),
          market_max: g.competitor.length ? round(Math.max(...g.competitor)) : null,
          targets_n: g.targets.length,
          targets_median: round(median(g.targets)),
          diff_pct: marketMedian !== null && ourRef ? Math.round(((marketMedian - ourRef) / ourRef) * 1000) / 10 : null,
          mentions: g.mentions,
          not_compared: g.not_compared,
          suppliers: [...g.suppliers].slice(0, 5),
          countries: [...g.countries].slice(0, 5),
        };
      })
      .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));

    const voiceRows = voices.map((v) => ({
      turn_id: Number(v.id),
      at: v.created_at,
      deal: { id: Number(v.deal_id), number: v.display_id === null ? null : Number(v.display_id), label: v.deal_label },
      flags: (v.flags ?? []).map((f: string) => ({ flag: f, label: f === 'price_objection' ? 'Дорого' : FLAG_LABELS[f as keyof typeof FLAG_LABELS] ?? f })),
      target_price: v.target_price,
      product: [v.product, v.size, v.grammage].filter(Boolean).join(' ') || null,
      quote: v.quote ? String(v.quote).replace(/\s+/g, ' ').trim() : null,
      event_id: v.quote_event_id === null ? null : Number(v.quote_event_id),
      summary: v.summary,
    }));

    const counts = {
      mentions: rows.length,
      competitor: rows.filter((r) => r.kind === 'competitor').length,
      client_target: rows.filter((r) => r.kind === 'client_target').length,
      deals: new Set([...rows.map((r) => r.deal.id), ...voiceRows.map((v) => v.deal.id)]).size,
      turns: voiceRows.length,
      flags: Object.fromEntries(MARKET_FLAGS.map((f) => [f, voiceRows.filter((v) => v.flags.some((x: any) => x.flag === f)).length])),
    };

    // ---- the filter lists: the countries named, our products that came up
    const cParams: unknown[] = [withMail];
    const cScope = dealScopeSql(access, cParams, 'd');
    const countries: { country: string }[] = await this.dataSource.query(
      `SELECT DISTINCT x.country FROM (
         SELECT m.country FROM market_mention m JOIN deal d ON d.id = m.deal_id AND d.deleted_at IS NULL
          WHERE m.country IS NOT NULL AND ($1::boolean OR NOT m.has_email) AND ${cScope}
         UNION SELECT i.country FROM deal_inbound i JOIN deal d ON d.id = i.deal_id AND d.deleted_at IS NULL
          WHERE i.country IS NOT NULL AND ($1::boolean OR NOT i.has_email) AND ${cScope}
       ) x ORDER BY x.country LIMIT 100`,
      cParams,
    );

    return {
      period,
      filters: { product: product || null, product_id: productId, country: country || null },
      withMail,
      currency: AI2.marketCurrency,
      rates: AI2.marketRates,
      rows,
      groups: groupRows,
      voices: voiceRows,
      counts,
      options: {
        countries: countries.map((c) => c.country),
        products: catalogue.filter((p) => productIds.includes(p.id)).map((p) => ({ id: p.id, name: p.name })),
      },
    };
  }

  private publicView(data: Awaited<ReturnType<AiMarketService['collect']>>) {
    return {
      period: { from: localDay(data.period.from), till: localDay(new Date(data.period.till.getTime() - 86_400_000)), label: data.period.label },
      filters: data.filters,
      currency: data.currency,
      compared_currencies: [data.currency, ...Object.keys(data.rates)],
      counts: data.counts,
      groups: data.groups,
      mentions: data.rows,
      voices: data.voices,
      options: data.options,
    };
  }

  // ------------------------------------------------------------------ the AI summary

  /** What the summary is made from: the same rows the user sees, shortened. */
  private summaryInput(data: Awaited<ReturnType<AiMarketService['collect']>>) {
    return {
      period: data.period.label,
      currency: data.currency,
      groups: data.groups.slice(0, 30).map((g) => ({
        product: g.name,
        unit: g.unit,
        catalogue: g.catalogue,
        deals_avg: g.deals_avg,
        our_quoted: g.our_quoted,
        market_n: g.market_n,
        market_min: g.market_min,
        market_median: g.market_median,
        market_max: g.market_max,
        targets_median: g.targets_median,
        diff_pct: g.diff_pct,
        suppliers: g.suppliers,
        countries: g.countries,
      })),
      mentions: data.rows.slice(0, 60).map((r) => ({
        at: localDay(new Date(r.at)),
        who: r.kind,
        supplier: r.supplier,
        country: r.country,
        product: [r.product, r.size, r.grammage].filter(Boolean).join(' ') || null,
        price: r.price_text ?? (r.price !== null ? `${r.price} ${r.currency ?? ''}`.trim() : null),
        price_in_our_currency: r.price_ours,
        our_price: r.our_price,
        moq: r.moq,
        delivery: r.delivery,
        quality: r.quality,
        payment: r.payment,
        quote: r.quote,
      })),
      voices: data.voices.slice(0, 40).map((v) => ({
        at: localDay(new Date(v.at)),
        signals: v.flags.map((f: any) => f.label),
        target_price: v.target_price,
        product: v.product,
        quote: v.quote ? String(v.quote).slice(0, 200) : null,
      })),
    };
  }

  private summaryHash(input: ReturnType<AiMarketService['summaryInput']>, withMail: boolean): string {
    return sha256({ v: PROMPT_VERSION_2.marketSummary, mail: withMail, ...input });
  }

  private async summaryView(user: AuthUser, q: MarketQuery, data: Awaited<ReturnType<AiMarketService['collect']>>): Promise<MarketSummaryState> {
    const input = this.summaryInput(data);
    const job = await this.queue.find('market_summary', this.summaryHash(input, data.withMail));
    if (job?.status === 'done') return this.state(job, true);
    // the last summary this user made with the same filters (stale)
    const filters = JSON.stringify({ ...data.filters, from: localDay(data.period.from), till: localDay(data.period.till) });
    const last: AiJobRow | undefined = (
      await this.dataSource.query(
        `SELECT * FROM ai_job WHERE kind = 'market_summary' AND entity = 'user' AND entity_id = $1 AND status = 'done'
            AND input->>'filters' = $2 ORDER BY finished_at DESC, id DESC LIMIT 1`,
        [user.sub, filters],
      )
    )[0];
    return {
      status: job ? job.status : last ? 'stale' : 'none',
      fresh: false,
      job_id: job?.id ?? null,
      made_at: last?.finished_at ?? null,
      data: (last?.result?.summary as MarketSummary) ?? null,
      error: job?.status === 'failed' ? 'Не удалось получить сводку, попробуйте ещё раз' : null,
    };
  }

  private state(job: AiJobRow, fresh: boolean): MarketSummaryState {
    return {
      status: job.status,
      fresh,
      job_id: job.id,
      made_at: job.finished_at ?? null,
      data: job.status === 'done' ? ((job.result?.summary as MarketSummary) ?? null) : null,
      error: job.status === 'failed' ? 'Не удалось получить сводку, попробуйте ещё раз' : job.status === 'skipped' ? job.error || 'Сводка не нужна' : null,
    };
  }

  /** «Сводка ИИ» of the market page: made now for the data the user sees (cached for the same data). */
  async summarize(user: AuthUser, q: MarketQuery, waitMs = AI.summaryWaitSec * 1000): Promise<MarketSummaryState> {
    if (!AI2.market) throw new ServiceUnavailableException('«Рынок» выключен администратором');
    const data = await this.collect(user, q);
    const input = this.summaryInput(data);
    if (!input.groups.length && !input.mentions.length && !input.voices.length) {
      return { status: 'empty', fresh: true, job_id: null, made_at: null, data: null, error: 'За этот период клиенты ничего не говорили о ценах и конкурентах' };
    }
    const hash = this.summaryHash(input, data.withMail);
    let job = await this.queue.find('market_summary', hash);
    if (job?.status === 'done') return { ...this.state(job, true), cached: true };
    try {
      await this.queue.assertNotPaused();
    } catch (error) {
      if (error instanceof AiPausedError) throw new ServiceUnavailableException(error.message);
      throw error;
    }
    const filters = JSON.stringify({ ...data.filters, from: localDay(data.period.from), till: localDay(data.period.till) });
    if (!job) {
      this.limit.take(user.sub);
      ({ job } = await this.queue.enqueue({
        kind: 'market_summary',
        entity: 'user',
        entityId: user.sub,
        inputHash: hash,
        // what is needed to build the same data again as this user (no client texts are copied into the job)
        input: { user_id: user.sub, query: { ...q }, filters, mail: data.withMail },
        priority: AiPriority.INTERACTIVE,
        promptVersion: PROMPT_VERSION_2.marketSummary,
        requestedBy: user.sub,
      }));
    } else if (job.status === 'failed' || job.status === 'skipped') {
      this.limit.take(user.sub);
      await this.queue.retry(job.id);
    }
    const finished = (await this.queue.wait(job.id, waitMs)) ?? job;
    return { ...this.state(finished, true), cached: false };
  }

  private async runSummary(job: AiJobRow): Promise<AiOutcome> {
    const user = await loadStaffUser(this.dataSource, Number(job.input?.user_id));
    if (!user) return { skipped: 'сотрудник удалён' };
    const data = await this.collect(user, job.input?.query ?? {});
    const input = this.summaryInput(data);
    if (!input.groups.length && !input.mentions.length && !input.voices.length) return { skipped: 'нет данных о рынке' };
    const raw = await this.queue.askJson(job, MARKET_SUMMARY_SYSTEM, marketSummaryPrompt({ now: new Date(), ...input }));
    if (!looksLikeMarketSummary(raw)) throw new AiFormatError('ИИ ответил не по формату сводки рынка');
    return { result: { summary: cleanMarketSummary(raw), mentions: input.mentions.length, groups: input.groups.length } };
  }
}

export type { MarketOffer };
