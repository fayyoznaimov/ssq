import type { FillerValue } from './filler';

export type Product = {
    id: number;
    name: string;
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