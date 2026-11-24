import {RouteLocationRaw} from 'vue-router';

export type Ordering = { [index: string]: 1 | -1 };

export interface Column<T = any> {
    icon?: string;
    label: string; // label displayed in column
    name: string; // required column for :key
    width?: number; // column width between 0 and 100
    field?: (item: T) => any; // if field function is provided it will use it to fill column content. You can also pass raw html here
    subtitle?: (item: T) => any; // same as field, but is displayed below the field content
    link?: (item: T) => RouteLocationRaw; // if provided content becomes a hyperlink
    rowAnchor?: boolean; // with the rowLink of BaseTable: the cell is a real link to the row's page (opens in a new tab, its address can be copied)
    click?: (item: T) => any; // if provided this function will be called when cell is clicked
    money?: boolean; // if true it will format the number as money using Money.vue
    phone?: boolean; // if true it will format the string as phone number using Phone.vue
    dateFormat?: string; // example: "calendar" or "MMM DD". More info about formatting in moment docs
    duration?: boolean;
    sortable?: boolean; // if true the column will become sortable
    classes?: (item: T) => string | undefined; // css classes to apply
    enums?: { [index: string]: string }; // if provided it will use the enum value to display the label
    decimalPoints?: number; // if provided it will round the number to the specified decimal points
    mask?: string; // if provided it will format the number using mask, ex.: +1 (###) ###-####
    resizable?: boolean;
    align?: 'left' | 'center' | 'right'; // money is right-aligned by default
    stage?: (item: T) => { name: string; color?: string | null } | null | undefined; // the cell is the stage as a coloured chip
    maxWidth?: number; // px; longer text is cut with «…» and shown whole on hover (default 320 for plain text)
    wrap?: boolean; // the text may take several lines instead of being cut
    // the row as a card on a phone (BaseTable, below 640 px): 'title' — the heading of the card (default: the first column),
    // 'show' — a line «label: value» (default), 'hide' — not on the card
    mobile?: 'title' | 'show' | 'hide';
    headerStyle?: Record<string, any>;
    style?: {
        overwrite?: boolean; // if true will overwrite any default styles
        value: object; // example: {width: "100px"}
    };
}
