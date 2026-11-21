import type { Filler } from "~/types/filler";

import type { UserRole } from "./user";

interface CtrAgentFiller extends Filler {
    value?: string;
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
};

interface Source {
    path: string;
}

export type CtrAgentSource = {
    files: Source[];
    recordings: Source[];
};
