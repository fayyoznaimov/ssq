import { formatDateAs } from "./format";

export function generateId(length = 8) {
    const timestamp = Date.now().toString(36); // Convert timestamp to base-36 string
    const randomString = Math.random().toString(36).substring(2, 2 + length); // Generate random string
    return `${timestamp}-${randomString}`;
}

export const generateNumberId = () => {
    return Math.floor(Math.random() * 10000000);
};

/**
 * A date of a list or a card. The old formats («MMM Do, HH:mm» → «нояб. 21-го», «DD.MM.YYYY HH:mm», ...) give the
 * one format of the CRM: «21 нояб. 2026, 18:35» (or «21 нояб. 2026» for a day), see utils/format.ts
 */
export const formatDate = (date: any, format: string): string => {
    return formatDateAs(date, format, "-");
};
