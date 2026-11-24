import type { Deal } from "./deal";
import type { Email } from "./mail";
import type { FileSource } from "./stage";
import type { User } from "./user";

export type MyFile = {
    id: number;
    created_at: string;
    deals: Deal[];
    from: FileSource;
    extension: string | null;
    name: string;
    path: string;
    size: string;
    uploaded_by: User;
    email?: Email;
    // the history row of a message that holds the file (GET /files): its time, type, deal and client
    message?: {
        at: string;
        type: number;
        deal: { id: number; label: string } | null;
        client: { id: number; username: string } | null;
    } | null;
}