import { validPhone } from "~/utils/validation";

/**
 * The phone of a company or a contact as the API takes it (helper/phone.ts there): an international
 * number, or 9 digits of a local number ("90 123 45 67": the API stores it as +998901234567).
 */
export function phoneOrLocal(message: string) {
    const check = validPhone(message);
    return (value: string | undefined) => (/^[1-9]\d{8}$/.test(String(value ?? "").replace(/[\s\-().]/g, ""))
        ? { ok: true as const, value: undefined }
        : check(value));
}
