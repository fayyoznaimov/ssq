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
    sanitized: {
        body: string;
        snippet: string;
    }
} 

export type Transporter = {
    id: number;
    email: string;
    created_at: string;
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