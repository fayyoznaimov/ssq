import type { CtrAgent } from "~/types/ctrAgent";

import type { Filler, FillerValue } from "./filler";

export type Company = {
    id: number;
    name: string;
    email: string;
    phone: string;
    created_at: string;
    fillers: FillerValue[];
    is_old: boolean;
    users: CompanyUser[];
    ctr_agents: CtrAgent[];
    // Requisites (all optional)
    inn?: string | null;
    legal_address?: string | null;
    bank_account?: string | null;
    bank_name?: string | null;
    mfo?: string | null;
    oked?: string | null;
    director?: string | null;
};

export type Group = {
    id: number;
    name: string;
    created_at: string;
};

export enum UserRole {
    Admin = "admin",
    Agent = "agent",
    Manager = "manager",
    CtrAgent = "ctr_agent",
}

export enum PermissionLevel {
    Forbidden = 0,
    Responsible = 1,
    Member = 2,
    Allowed = 3,
}

type Actions = "create" | "delete" | "view" | "update" | "export";

export type User = {
    id: number;
    email: string;
    username: string;
    phone: string;
    company: Company | null;
    role: UserRole;
    permissions: {
        deal: {
            [key in Actions]: PermissionLevel;
        };
        company: {
            [key in Actions]: PermissionLevel;
        };
        task: {
            [key in Actions]: PermissionLevel;
        };
        contact: {
            [key in Actions]: PermissionLevel;
        };
        file: boolean;
        mail: boolean;
    };
    group: Group | null;
    tg_id: string | null;
    wa_id?: string | null;
    avatar?: string | null;
    created_at: string;
    updated_at: string;
    user_fillers: FillerValue[];
};

interface CompanyUserFiller {
    id: number;
    value?: string;
    created_at: string;
    filler: Filler;
}

export type CompanyUser = {
    id: number;
    username: string;
    email: string;
    phone: string;
    role: UserRole.CtrAgent;
    permissions: null;
    tg_id: null;
    objectives: {
        yearly: number;
        monthly: number;
        quarterly: number;
    };
    updated_at: string;
    deleted_at: null;
    created_at: string;
    user_fillers: CompanyUserFiller[];
};

export type Contact = UserContact | CompanyContact;

export type UserContact = {
    id: number;
    type: UserRole.CtrAgent;
    name: string;
    phones: string[];
    emails: string[];
    company: Company | null;
    user_fillers: FillerValue[];
};

export type CompanyContact = {
    id: number;
    type: "company";
    name: string;
    phones: string[];
    emails: string[];
    company: null;
    company_fillers: FillerValue[];
};

export type AgentStat = {
    id: number;
    username: string;
    email: string;
    phone: string;
    created_at: string;
    deal_count: number;
    average_budget: number;
    new_client_count: number;
    total_call_duration: number;
    average_telegram_response_time: number;
    average_email_response_time: number;
};
