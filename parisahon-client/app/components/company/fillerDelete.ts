import { useService } from "~/composables/useService";
import { russianDecline } from "~/utils/text";

/**
 * Before a custom field is deleted: how many records have a value of it (GET /fillers/:id/usage), and
 * a confirmation — the field goes with every value it has, in all companies, contacts, deals or products,
 * and they cannot be brought back. One click used to do it.
 */
export async function confirmFillerDelete(fillersService: ReturnType<typeof useService>, id: number): Promise<boolean> {
    let text = "Удалить поле? Все его значения будут удалены навсегда.";
    try {
        const usage = await fillersService.get<{ field: string; values: number }>(`${id}/usage`).exec();
        const count = Number(usage?.values ?? 0);
        text = count
            ? `Удалить поле «${usage.field}»? Оно заполнено у ${count} ${russianDecline(count, "записи", "записей", "записей")}: эти значения будут удалены навсегда.`
            : `Удалить поле «${usage.field}»? Оно ещё нигде не заполнено.`;
    } catch {
        // the count is not known: ask anyway
    }
    return confirm(text);
}
