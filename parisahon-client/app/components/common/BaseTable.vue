<template>
    <div class="relative" :class="asCards ? '' : 'overflow-x-auto'">
        <!-- one cell, for the table and for the cards on a phone -->
        <DefineCell v-slot="{ item, column, card }">
            <!-- a cell that leads to a page is a real link: it opens in a new tab and its address can be copied -->
            <component
                :is="isAnchor(item, column) ? NuxtLink : 'div'"
                v-bind="isAnchor(item, column) ? { to: cellLink(item, column) } : {}"
                :class="cellBoxClass(item, column, card)"
                :style="cellBoxStyle(column, card)"
                :title="cellTitle(item, column)"
            >
                <slot
                    :name="column.name"
                    :item="item"
                    :column="column"
                >
                    <StageChip v-if="column.stage" :stage="column.stage(item)" />
                    <span v-else-if="column.dateFormat">{{ formatDateAs(item[column.name] ?? column.field?.(item), column.dateFormat, '—') }}</span>
                    <template v-else-if="column.money">
                        <Money :value="getValue(item, column)" />
                    </template>
                    <template v-else-if="column.phone">
                        <Phone
                            :value="getValue(item, column)"
                            hyperlink
                        />
                    </template>
                    <!-- values are text: names come from clients (Telegram, WhatsApp), never markup -->
                    <span v-else>{{ getValue(item, column) }}</span>
                    <div
                        v-if="column.subtitle"
                        class="text-muted-400 dark:text-muted-400 text-sm truncate"
                    >{{ column.subtitle(item) }}</div>
                </slot>
            </component>
        </DefineCell>

        <!-- an empty list: nothing found, or the list did not load (it said «Пока ничего» after a failed request too) -->
        <DefineEmpty>
            <div v-if="loadFailed" class="flex flex-col items-center gap-2 whitespace-normal" role="alert">
                <span class="font-medium text-muted-700 dark:text-muted-100">Не удалось загрузить список</span>
                <span v-if="typeof props.error === 'string' && props.error" class="text-xs text-muted-500 dark:text-muted-400">{{ props.error }}</span>
                <BaseButton size="sm" @click="retry">
                    <Icon name="ph:arrow-clockwise" class="me-1 size-4" />
                    Повторить
                </BaseButton>
            </div>
            <span v-else class="whitespace-normal text-muted-500 dark:text-muted-300">{{ props.emptyText }}</span>
        </DefineEmpty>

        <!-- a phone: every row is a card (the table showed two columns and hid the rest past the edge) -->
        <div v-if="asCards" class="flex flex-col gap-3" data-cards>
            <div
                v-if="props.bulkActions && props.data.length && !loading"
                class="flex items-center gap-3 px-1 text-sm text-muted-500 dark:text-muted-400"
            >
                <BaseCheckbox
                    :indeterminate="isIntermediate"
                    :model-value="isEverythingSelected"
                    label="Выбрать все"
                    @update:model-value="selectAll($event)"
                />
            </div>
            <template v-if="loading">
                <div
                    v-for="n in Math.min(props.shimmerSlots, 4)"
                    :key="n"
                    class="rounded-md border border-muted-200 bg-white p-4 dark:border-muted-700 dark:bg-muted-800"
                >
                    <BasePlaceload class="h-4 w-2/3 rounded-md" />
                    <BasePlaceload class="mt-3 h-3 w-full rounded-md" />
                    <BasePlaceload class="mt-2 h-3 w-1/2 rounded-md" />
                </div>
            </template>
            <div
                v-else-if="!props.data.length"
                class="rounded-md border border-muted-200 bg-white px-4 py-6 text-center text-sm text-muted-500 dark:border-muted-700 dark:bg-muted-800 dark:text-muted-300"
            >
                <ReuseEmpty />
            </div>
            <template v-else>
                <div
                    v-for="item in props.data"
                    :key="item.id"
                    data-card
                    class="rounded-md border border-muted-200 bg-white p-4 text-sm text-muted-600 dark:border-muted-700 dark:bg-muted-800 dark:text-muted-200"
                    :class="props.rowLink && 'cursor-pointer active:bg-muted-50 dark:active:bg-muted-700/60'"
                    @click="onCardClick($event, item)"
                >
                    <div class="flex items-start gap-3">
                        <BaseCheckbox
                            v-if="props.bulkActions"
                            :model-value="isRowSelected(item)"
                            @update:model-value="setSelected(item, $event)"
                        />
                        <div class="min-w-0 flex-1">
                            <!-- a field with its own click or link keeps it on the card (a task opens its window) -->
                            <div
                                v-if="cardTitle"
                                class="break-words text-base font-medium text-muted-800 dark:text-white"
                                :class="(cardTitle.click || cardTitle.link) && 'cursor-pointer'"
                                @click.stop="onCellClick($event, item, cardTitle)"
                            >
                                <ReuseCell :item="item" :column="cardTitle" :card="true" />
                            </div>
                            <dl
                                v-if="cardFields.length"
                                class="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5"
                            >
                                <template v-for="column in cardFields" :key="column.name">
                                    <template v-if="!isBlank(item, column)">
                                        <dt class="text-muted-400 dark:text-muted-400">{{ column.label }}</dt>
                                        <dd
                                            class="min-w-0 break-words text-muted-700 dark:text-muted-100"
                                            :class="[(column.click || column.link) && 'cursor-pointer', column.classes?.(item)]"
                                            @click.stop="onCellClick($event, item, column)"
                                        >
                                            <ReuseCell :item="item" :column="column" :card="true" />
                                        </dd>
                                    </template>
                                </template>
                            </dl>
                        </div>
                    </div>
                    <div
                        v-if="cardActions.length || slots.buttons"
                        class="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-muted-200 pt-3 dark:border-muted-700 [&>td]:block [&>td]:p-0"
                    >
                        <ReuseCell
                            v-for="column in cardActions"
                            :key="column.name"
                            :item="item"
                            :column="column"
                            :card="true"
                        />
                        <slot
                            :item="item"
                            name="buttons"
                        />
                    </div>
                </div>
            </template>
        </div>

        <TairoTable
            v-else
            class="dark:bg-muted-800 bg-muted-50 whitespace-nowrap w-full"
            shape="rounded"
            :local-storage-key="localStorageKey"
        >
            <template #header="{widths}">
                <TairoTableHeading
                    v-if="props.bulkActions"
                    class="p-4 min-w-12 max-w-12 w-12"
                    name="bulkActions"
                    :local-storage-key="localStorageKey"
                >
                    <BaseCheckbox
                        :indeterminate="isIntermediate"
                        :model-value="isEverythingSelected"
                        type="checkbox"
                        @update:model-value="selectAll($event)"
                    />
                </TairoTableHeading>
                <TairoTableHeading
                    v-for="column in columns"
                    :key="column.name"
                    class="py-2.5 px-4 relative whitespace-nowrap"
                    :class="alignClass(column)"
                    scope="col"
                    :resizable="column.resizable"
                    :style="column.headerStyle"
                    :width="widths[column.name]"
                    :name="column.name"
                    :local-storage-key="localStorageKey"
                >
                    <Icon
                        v-if="column.icon"
                        :name="column.icon"
                        class="size-5 mr-1.5"
                    />
                    <a
                        v-if="column.sortable"
                        :class="{
                            'cursor-pointer select-none align-middle':
                                column.sortable,
                        }"
                        href="#"
                        @click.prevent="setOrdering(column.name)"
                    >
                        {{ column.label }}
                    </a>
                    <span
                        v-else
                        class="align-middle"
                    >{{
                        column.label
                    }}</span>
                    <span
                        v-if="props.sortBy[column.name]"
                        class="ml-1"
                    >
                        <Icon
                            v-if="props.sortBy[column.name] === 1"
                            name="ph:caret-down"
                        />
                        <Icon
                            v-else-if="props.sortBy[column.name] === -1"
                            name="ph:caret-up"
                        />
                    </span>
                </TairoTableHeading>
            </template>
            <template v-if="loading">
                <TairoTableRow
                    v-for="n in props.shimmerSlots"
                    :key="n"
                >
                    <TairoTableCell
                        v-if="props.bulkActions"
                        class="p-4"
                    >
                        <BasePlaceload class="h-4 rounded-md w-full" />
                    </TairoTableCell>
                    <TairoTableCell
                        v-for="column in props.columns"
                        :key="column.name"
                        class="p-4"
                    >
                        <BasePlaceload class="h-4 rounded-md w-full min-w-12" />
                    </TairoTableCell>
                </TairoTableRow>
            </template>
            <TairoTableRow v-else-if="!props.data.length" :hoverable="false">
                <TairoTableCell
                    :colspan="columnsCount"
                    class="text-center py-6 px-4"
                >
                    <ReuseEmpty />
                </TairoTableCell>
            </TairoTableRow>
            <template v-else>
                <TairoTableRow
                    v-for="item in props.data"
                    :key="item.id"
                >
                    <TairoTableCell
                        v-if="bulkActions"
                        class="p-4"
                    >
                        <BaseCheckbox
                            :model-value="isRowSelected(item)"
                            @update:model-value="setSelected(item, $event)"
                        />
                    </TairoTableCell>
                    <TairoTableCell
                        v-for="column in props.columns"
                        :key="column.name"
                        :class="[columnClass(item, column), alignClass(column)]"
                        :style="columnStyle(column)"
                        :light="true"
                        class="p-4"
                        @click="onCellClick($event, item, column)"
                    >
                        <ReuseCell :item="item" :column="column" />
                    </TairoTableCell>
                    <slot
                        :item="item"
                        name="buttons"
                    />
                </TairoTableRow>
            </template>
        </TairoTable>
    </div>
</template>

<script lang="ts" setup>
import { createReusableTemplate, useMediaQuery } from "@vueuse/core";
import { conformToMask } from "text-mask-core";
import type { RouteLocationRaw } from "vue-router";

import { NuxtLink } from "#components";

import Money from "~/components/common/Money.vue";
import Phone from "~/components/common/Phone.vue";
import { type Column } from "~/components/common/types";
import StageChip from "~/components/deal/StageChip.vue";
import TairoTable from "~/components/tairo/TairoTable.vue";
import TairoTableCell from "~/components/tairo/TairoTableCell.vue";
import TairoTableHeading from "~/components/tairo/TairoTableHeading.vue";
import TairoTableRow from "~/components/tairo/TairoTableRow.vue";
import { loadFailures } from "~/composables/useService";
import { formatDateAs, formatNumber } from "~/utils/format";
import { stringToMask } from "~/utils/text";

interface Props {
    columns: Column[];
    data: any[];
    sortBy: Record<string, number>;
    actions?: boolean;
    loading?: boolean;
    bulkActions?: boolean;
    selected?: any[];
    selector?: (t: any) => any;
    shimmerSlots?: number;
    id?: string;
    // the page of a row: a click anywhere in the row opens it (with Ctrl, Cmd or Shift — in a new tab)
    rowLink?: (item: any) => RouteLocationRaw;
    // the list did not load: «Не удалось загрузить» and «Повторить» instead of «Пока ничего нет»
    // (a text is shown as the reason). Without it a failed GET while the table was loading is noticed itself
    error?: boolean | string | null;
    // the text of an empty list («Пока никто не подключил WhatsApp»)
    emptyText?: string;
    // below 640 px the rows are cards; false keeps the table (it scrolls sideways)
    cards?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    shimmerSlots: 10,
    selector: (t: any) => t.id,
    selected: () => [],
    emptyText: "Пока ничего нет",
    cards: true,
});

const localStorageKey = (props.id || "-1") + "-widths";
const emit = defineEmits(["update:selected", "update:sortBy", "retry"]);
const slots = useSlots();
const instance = getCurrentInstance();

const [DefineCell, ReuseCell] = createReusableTemplate<{ item: any; column: Column; card?: boolean }>();

const [DefineEmpty, ReuseEmpty] = createReusableTemplate();

const isPhone = useMediaQuery("(max-width: 639px)");
const asCards = computed(() => props.cards && isPhone.value);

/* ---------- a failed load ---------- */

// a GET that failed (no answer, 5xx, an unknown address) while this table was loading
const autoFailed = ref(false);
let failuresAtStart = loadFailures.value;
watch(
    () => props.loading,
    (now, before) => {
        if (now) {
            failuresAtStart = loadFailures.value;
            autoFailed.value = false;
        } else if (before) {
            autoFailed.value = loadFailures.value > failuresAtStart;
        }
    },
    { immediate: true }
);

const loadFailed = computed(() => {
    if (props.loading || props.data.length) return false;
    // the page says itself whether the list loaded
    if (instance?.vnode.props && "error" in instance.vnode.props) return !!props.error;
    return autoFailed.value;
});

function retry() {
    // the page reloads the list itself; a page that does not listen is loaded again
    if (instance?.vnode.props?.onRetry) emit("retry");
    else window.location.reload();
}

/* ---------- selection ---------- */

const columnsCount = computed(() => {
    let columnsCount = props.columns.length + (props.bulkActions ? 1 : 0);
    if (props.actions) {
        columnsCount++;
    }
    return columnsCount;
});

const isEverythingSelected = computed(() => {
    const selectedCount = new Set(props.selected).size;
    const allCount = new Set(props.data.map(props.selector)).size;
    return allCount > 0 && selectedCount === allCount;
});

const isIntermediate = computed(
    () => props.selected.length > 0 && !isEverythingSelected.value
);

function isRowSelected(item: any) {
    const id = props.selector(item);
    if (!props.selected) throw new Error("props.selected was not provided");
    return props.selected.includes(id);
}

function setSelected(item: any, val: boolean) {
    const id = props.selector(item);
    if (!props.selected) {
        throw new Error("props.selected was not provided");
    }
    if (val) {
        emit("update:selected", Array.from(new Set([...props.selected, id])));
    } else {
        emit(
            "update:selected",
            props.selected.filter((s) => s !== id)
        );
    }
}

/* ---------- cards ---------- */

const isActionColumn = (column: Column) => column.name === "actions" || !column.label;

/** the heading of a card: the column marked 'title', otherwise the first one */
const cardTitle = computed(() =>
    props.columns.find((c) => c.mobile === "title")
    ?? props.columns.find((c) => !isActionColumn(c) && c.mobile !== "hide")
);
const cardFields = computed(() =>
    props.columns.filter((c) => c !== cardTitle.value && !isActionColumn(c) && c.mobile !== "hide")
);
const cardActions = computed(() =>
    props.columns.filter((c) => isActionColumn(c) && c.mobile !== "hide" && slots[c.name])
);

/** an empty value is not shown on a card («Почта: —» says nothing) */
function isBlank(item: any, column: Column) {
    if (slots[column.name] || column.stage || column.subtitle) return false;
    const value = column.dateFormat ? item[column.name] ?? column.field?.(item) : getValue(item, column);
    return value === null || value === undefined || value === "" || value === "-" || value === "—";
}

function onCardClick(e: MouseEvent, item: any) {
    if (!props.rowLink) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("a, button, input, label, select, textarea")) return;
    if (window.getSelection()?.toString()) return;
    const link = props.rowLink(item);
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
        window.open(router.resolve(link).href, "_blank", "noopener");
        return;
    }
    router.push(link);
}

/* ---------- cells ---------- */

const router = useRouter();

/** Where a cell leads: the column's own link, otherwise the page of the row (not for actions or a cell with its own click) */
function cellLink(item: any, column: Column) {
    if (column.link) return column.link(item);
    if (props.rowLink && column.name !== "actions" && !column.click) return props.rowLink(item);
}

/** The cell is rendered as a link: a column with its own link or one marked `rowAnchor` (a phone keeps its tel: link) */
function isAnchor(item: any, column: Column) {
    if (column.phone || column.name === "actions" || (!column.link && !column.rowAnchor)) return false;
    return !!cellLink(item, column);
}

/** Clicks on links, buttons and fields inside the cell keep their own action; selecting text does not open the row */
function onCellClick(e: MouseEvent, item: any, column: Column) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("a, button, input, label, select, textarea")) return;
    if (column.click) return column.click(item);
    const link = cellLink(item, column);
    if (!link || window.getSelection()?.toString()) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
        window.open(router.resolve(link).href, "_blank", "noopener");
        return;
    }
    router.push(link);
}

function setOrdering(column: string) {
    const order = props.sortBy[column] || 1;
    emit("update:sortBy", { [column]: order === 1 ? -1 : 1 });
}

function getValue(item: any, column: Column<any>) {
    if (column.object) {
        return item[column.name]?.name || "-";
    }
    if (column.field) {
        return column.enums
            ? column.enums[column.field(item)]
            : column.field(item);
    }
    if (column.enums) {
        return column.enums[item[column.name]];
    }
    if (column.mask) {
        return conformToMask(item[column.name], stringToMask(column.mask), {
            guide: false,
        }).conformedValue;
    }
    if (column.decimalPoints !== undefined) {
        return formatNumber(item[column.name] || 0, column.decimalPoints);
    }
    return item[column.name];
}

/** a plain text cell (no slot of the page, no chip) is cut at its width and shown whole on hover */
function isPlainText(column: Column) {
    return !slots[column.name] && !column.stage && !column.money && !column.phone;
}

const DEFAULT_MAX_WIDTH = 320;

function cellBoxClass(item: any, column: Column, card?: boolean) {
    const anchor = isAnchor(item, column);
    // a card has the width of the screen: the text takes several lines instead of being cut
    if (card) return anchor ? "block text-inherit whitespace-normal break-words" : isPlainText(column) ? "block whitespace-normal break-words" : "contents";
    if (column.wrap) return [anchor ? "block text-inherit" : "block", "whitespace-normal break-words"];
    if (anchor || column.maxWidth || isPlainText(column)) {
        return ["block overflow-hidden text-ellipsis", anchor && "text-inherit"];
    }
    return "contents";
}

function cellBoxStyle(column: Column, card?: boolean) {
    if (card) return undefined;
    if (column.wrap) return column.maxWidth ? { maxWidth: `${column.maxWidth}px` } : undefined;
    if (column.maxWidth) return { maxWidth: `${column.maxWidth}px` };
    if (isPlainText(column)) return { maxWidth: `${DEFAULT_MAX_WIDTH}px` };
    return undefined;
}

/** the whole text of a cell that may be cut */
function cellTitle(item: any, column: Column) {
    if ((!isPlainText(column) && !column.maxWidth) || column.dateFormat || column.money || column.stage) return undefined;
    const value = getValue(item, column);
    if (value === null || value === undefined) return undefined;
    const text = String(value);
    return text.length > 20 ? text : undefined;
}

function alignClass(column: Column) {
    const align = column.align ?? (column.money ? "right" : undefined);
    if (align === "right") return "!text-right";
    if (align === "center") return "!text-center";
    return undefined;
}

function columnClass(item: any, column: Column) {
    return [
        { "cursor-pointer": column.link || column.click || (props.rowLink && column.name !== "actions") },
        column.classes?.(item),
    ];
}

/**
 * The style of a cell: a column's own width or style. There is no default width any more: every cell was cut to
 * 150 px («ПЕРВИЧНЫЙ...», «11,400,...») even with the screen half empty; a long text is cut by its box (cellBoxStyle)
 */
function columnStyle(column: Column): object | object[] | undefined {
    const style: Record<string, string> = {};
    if (column.width) style["width"] = `${column.width}%`;
    if (!column.style) return style;
    if (column.style.overwrite) return column.style.value;
    return [style, column.style.value];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function selectAll(val: boolean) {
    if (val) {
        let selected = new Set(props.selected);
        for (let item of props.data) {
            selected.add((props.selector as any)(item));
        }
        emit("update:selected", Array.from(selected));
    } else {
        emit("update:selected", []);
    }
}
</script>

<style scoped></style>
