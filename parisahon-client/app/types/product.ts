import type { FillerValue } from './filler';

export type Product = {
    id: number;
    name: string;
    // the catalogue: article, unit (м, кг, шт …) and the base price of one unit
    sku?: string | null;
    unit?: string | null;
    price?: number | null;
    product_fillers: FillerValue[];
}

export type ProductStat = {
    id: number;
    name: string;
    deal_count: number;
    average_price_per_product: number;
    average_price_per_deal: number;
    total_price_sold: number;
}