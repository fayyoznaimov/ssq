import moment from "moment";

export function generateId(length = 8) {
    const timestamp = Date.now().toString(36); // Convert timestamp to base-36 string
    const randomString = Math.random().toString(36).substring(2, 2 + length); // Generate random string
    return `${timestamp}-${randomString}`;
}

export const generateNumberId = () => {
    return Math.floor(Math.random() * 10000000);
};

export const formatDate = (date: any, format: string): string => {
    if (!date) return "-";

    if (format === "calendar") {
        return moment.utc(date).locale("ru").local().calendar();
    }
    return moment.utc(date).locale("ru").local().format(format);
};