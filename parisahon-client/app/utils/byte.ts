export enum Unit {
  MB = 'MB',
  KB = 'KB',
  GB = 'GB',
  B = 'B'
}

const ONE_KB = 1024;
const ONE_MB = ONE_KB * ONE_KB;
const ONE_GB = ONE_MB * 1024;
const ONE_TB = ONE_GB * 1024;

const conversionTable: Record<Unit, number> = {
    [Unit.MB]: ONE_MB,
    [Unit.KB]: ONE_KB,
    [Unit.GB]: ONE_GB,
    [Unit.B]: 1
};

export function getUnit(bytes: number = 0): Unit {
    let unit = Unit.MB;
    if (bytes > ONE_MB && bytes < ONE_GB) {
        unit = Unit.MB;
    } else if (bytes > ONE_GB && bytes < ONE_TB) {
        unit = Unit.GB;
    } else if (bytes > ONE_KB && bytes < ONE_MB) {
        unit = Unit.KB;
    } else if (bytes < 1024) {
        unit = Unit.B;
    }

    return unit;
}

export function toBytes(unit: Unit, value: number) {
    return conversionTable[unit] * value;
}

export function toUnit(unit: Unit, value: number = 0) {
    return value / conversionTable[unit];
}

export function formatBytes(bytes: number) {
    const unit = getUnit(bytes);
    return `${Math.floor(toUnit(unit, bytes))}${unit}`;
}