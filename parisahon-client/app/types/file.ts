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
}