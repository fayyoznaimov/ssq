import type { Filler } from "~/types/filler";

import type { UserRole } from "./user";

interface CtrAgentFiller extends Filler {
    value?: string;
    // the id of the contact's value of this field (GET /companies/:id), none for a field without a value
    value_id?: number;
}

export type CtrAgent = {
    // Temp - used for new agents
    tempId?: string;

    // DTO
    id?: number;
    username?: string;
    email?: string;
    phone?: string;
    role: UserRole.CtrAgent;
    fillers: CtrAgentFiller[];
    // a contact being added by the user, not saved yet
    new?: boolean;
};

interface Source {
    path: string;
}

/** A file of a deal of the company (GET /companies/:id/sources). */
export interface CompanyFileSource extends Source {
    id: number;
    name?: string;
    size?: number;
    created_at?: string;
    deal: number;
    deal_label?: string;
}

/** A call recording of the company: who recorded it, which way, how long, in which deal. */
export interface CompanyCallSource extends Source {
    id: number;
    created_at: string;
    duration: number;
    outgoing: boolean;
    from_number?: string | null;
    manager: { id: number; username: string } | null;
    deal: { id: number; label: string } | null;
}

export type CtrAgentSource = {
    files: CompanyFileSource[];
    recordings: CompanyCallSource[];
};
