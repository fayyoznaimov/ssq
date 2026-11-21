export interface  FillerEntity {
    id: number;
    value?: string;
}

export type Filler = {
    id: number;
    target: string;
    field: string;
    created_at: string;
    is_required: boolean;
}

export interface FillerForm extends Filler {
    value?: string;
}

export interface FillerValue extends FillerEntity {
    created_at: string;
    filler: Filler;
    new: boolean;
    tempId: string;
}

export type FillersResponse = {
    company: Filler[];
    user: Filler[];
}

export interface FillersCreate {
    filler_id: number;
    value: string;
}
