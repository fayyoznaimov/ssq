type Recepient = {
    id: number;
    value: string;
}

type Attachment = {
    id: number;
    name: string;
    path: string;
}

export type Email = {
    id: number;
    email_id: string;
    from: string;
    subject: string;
    body: string;
    sent_at: string;
    to: Recepient[];
    cc: Recepient[];
    files: Attachment[];
    outgoing: boolean;
    read: boolean;
    message_id?: string | null;
    // The staff member who sent the email from the CRM (outgoing only)
    sent_by?: { id: number; username: string } | null;
    // the sender's display name, the thread (Message-IDs it answers)
    from_name?: string | null;
    in_reply_to?: string | null;
    // the HTML part of a received letter (only when one letter is opened)
    html?: string | null;
    is_spam?: boolean;
    deleted_at?: string | null;
    // the deals whose history the letter is in, those the user may see
    deals?: MailDeal[];
    // the contact / company of the sender, or of the recipients of a letter we sent
    client?: MailClient;
    sanitized: {
        body: string;
        snippet: string;
    }
} 

export type MailDeal = {
    id: number;
    label: string;
    display_id: number;
    stage: string | null;
    stage_color: string | null;
    closed: boolean;
}

export type MailClient = {
    contact: { id: number; username: string } | null;
    company: { id: number; name: string } | null;
}

/** GET /emails/sync-status, and `sync` of GET /emails/sync */
export type MailSyncStatus = {
    ok: boolean;
    running: boolean;
    last_run_at: string | null;
    last_success_at: string | null;
    errors: { mailbox: string; message: string }[];
    failing: { mailbox: string; uid: number; attempts: number; error: string }[];
    skipped: { mailbox: string; uid: number; subject: string | null; error: string; at: string }[];
}

/** POST /emails/deals */
export type DealFromLetters = {
    address: string;
    deal: { id: number; label: string; display_id: number };
    contact: { id: number; username: string };
    created_contact: boolean;
    letters: number;
}

export type Transporter = {
    id: number;
    email: string;
    created_at: string;
    // the mail server accepted the address and password (saved after the check)
    verified_at?: string | null;
    // the admin's list of everybody's mailboxes (GET /emails/transporters?all=true)
    created_by?: { id: number; username: string; email: string } | null;
}

export type Template = {
    id: number;
    template_body: string;
    name: string;
    subject: string;
}

export type Signature = {
    user_id: number;
    username: string;
    sign: string;
}