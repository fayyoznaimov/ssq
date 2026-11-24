import moment from "moment";

/** A period of the reports: [first day, last day] (YYYY-MM-DD, both included); null — all time. */
export type ReportPeriod = [string, string] | null;

const KEY = "crm-report-period";
const PLAIN = /^\d{4}-\d{2}-\d{2}$/;
// what the APIs that need both ends get for «за всё время» (the consolidated report starts its graph at the first deal)
export const ALL_TIME_FROM = "2020-01-01";
export const ALL_TIME_TILL = "2100-12-31";

function currentMonth(): ReportPeriod {
    return [moment().startOf("month").format("YYYY-MM-DD"), moment().endOf("month").format("YYYY-MM-DD")];
}

/**
 * The one period of every report («Аналитика»): kept in the address (?from=…&to=…, ?period=all) so a
 * link opens the same numbers, and in the browser tab (sessionStorage), so going from one report to
 * another keeps it. A report without a period in the address and nothing chosen yet shows `fallback`.
 *   const { period, params } = useReportPeriod();      // params: {from_date, till_date} or {}
 */
export function useReportPeriod(fallback: "month" | "all" = "month") {
    const route = useRoute();
    const router = useRouter();

    function read(): ReportPeriod | undefined {
        if (route.query.period === "all") return null;
        const from = String(route.query.from ?? "");
        const to = String(route.query.to ?? "");
        if (PLAIN.test(from) && PLAIN.test(to)) return from <= to ? [from, to] : [to, from];
        try {
            const saved = sessionStorage.getItem(KEY);
            if (saved === "all") return null;
            const [a, b] = String(saved ?? "").split("_");
            if (PLAIN.test(a ?? "") && PLAIN.test(b ?? "")) return [a, b];
        } catch {
            // no storage (private mode): the default
        }
        return undefined;
    }

    const initial = read();
    const period = ref<ReportPeriod>(initial === undefined ? (fallback === "all" ? null : currentMonth()) : initial);

    watch(period, (value) => {
        const query: Record<string, any> = { ...route.query };
        delete query.from;
        delete query.to;
        delete query.period;
        if (value) {
            query.from = value[0];
            query.to = value[1];
        } else {
            query.period = "all";
        }
        router.replace({ query });
        try {
            sessionStorage.setItem(KEY, value ? value.join("_") : "all");
        } catch {
            // nothing to keep it in
        }
    });

    /** from_date / till_date of the API, none for all time */
    const params = computed<Record<string, string>>(() => (period.value ? { from_date: period.value[0], till_date: period.value[1] } : {}));
    /** the same, with the far ends for «за всё время» (the APIs that need both dates) */
    const bounds = computed<{ from_date: string; till_date: string }>(() =>
        period.value ? { from_date: period.value[0], till_date: period.value[1] } : { from_date: ALL_TIME_FROM, till_date: ALL_TIME_TILL },
    );

    return { period, params, bounds };
}
