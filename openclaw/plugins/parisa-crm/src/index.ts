import { Type, type Static } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

/**
 * Parisa CRM tools for the OpenClaw Telegram bot.
 *
 * The bot's own model reads the photo of a company card / business card;
 * these tools only talk to the CRM API:
 *   crm_check_card     - normalize the recognized fields, format warnings, duplicates
 *   crm_create_company - create the company with its contacts (after the user confirmed)
 *   crm_add_contact    - add a person to an existing company
 *
 * The CRM credentials live in the plugin config (filled from env vars in
 * openclaw.json) and never reach the model.
 */

const configSchema = Type.Object(
  {
    apiUrl: Type.String({ description: "CRM API base URL, e.g. http://crm-app:3000/api/v1" }),
    webUrl: Type.String({ description: "CRM web URL used in links, e.g. http://localhost:4100" }),
    email: Type.String({ description: "Login of the CRM service account" }),
    password: Type.String({ description: "Password of the CRM service account" }),
  },
  { additionalProperties: false },
);
type Config = Static<typeof configSchema>;

const nullableText = (description: string) =>
  Type.Optional(Type.Union([Type.String(), Type.Null()], { description }));

const companyFields = Type.Object(
  {
    name: nullableText("Organisation name with its legal form, exactly as printed"),
    inn: nullableText("ИНН / STIR, digits as printed"),
    legal_address: nullableText("Legal address as printed"),
    bank_account: nullableText("Bank account (р/с, х/р), digits as printed"),
    bank_name: nullableText("Bank name as printed"),
    mfo: nullableText("МФО / БИК, digits as printed"),
    oked: nullableText("ОКЭД, digits as printed"),
    director: nullableText("Head of the organisation"),
    phone: nullableText("Organisation phone"),
    email: nullableText("Organisation email"),
  },
  { additionalProperties: false },
);

const contactFields = Type.Object(
  {
    full_name: nullableText("Full name of the person as printed"),
    position: nullableText("Job title as printed"),
    phone: nullableText("Phone as printed"),
    email: nullableText("Email as printed"),
  },
  { additionalProperties: false },
);

type Company = Static<typeof companyFields>;
type Contact = Static<typeof contactFields>;

// ---------------------------------------------------------------- CRM client

class CrmError extends Error {}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function login(config: Config): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(`${config.apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (!res.ok) {
    throw new CrmError(`CRM login failed (${res.status}). Check the service account in the plugin config.`);
  }
  const { access_token } = (await res.json()) as { access_token: string };
  // The CRM issues 24 h tokens; read the real expiry from the JWT payload.
  let expiresAt = Date.now() + 60 * 60 * 1000;
  try {
    const payload = JSON.parse(Buffer.from(access_token.split(".")[1], "base64url").toString());
    if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
  } catch {
    // keep the 1 h default
  }
  cachedToken = { token: access_token, expiresAt };
  return access_token;
}

async function crm<T>(config: Config, method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const token = await login(config);
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !retried) {
    cachedToken = null;
    return crm<T>(config, method, path, body, true);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join("; ") : data?.message ?? res.statusText;
    throw new CrmError(`CRM ${method} ${path} -> ${res.status}: ${message}`);
  }
  return data as T;
}

// ---------------------------------------------------------------- helpers

/** The CRM validates phones as international numbers; local Uzbek numbers get +998. */
function normalizePhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return undefined;
}

function clean(value: string | null | undefined): string | undefined {
  const v = value?.replace(/\s+/g, " ").trim();
  return v ? v : undefined;
}

async function positionFillerId(config: Config): Promise<number | null> {
  // "Должность" is a custom field of contacts in this CRM
  const fillers = await crm<{ user?: { id: number; field: string }[] }>(config, "GET", "/fillers");
  return fillers.user?.find((f) => f.field.trim().toLowerCase() === "должность")?.id ?? null;
}

async function createContact(config: Config, companyId: number, contact: Contact, fillerId: number | null) {
  const username = clean(contact.full_name);
  if (!username || username.length < 3) {
    throw new CrmError("A contact needs a name of at least 3 characters");
  }
  const position = clean(contact.position);
  return crm<{ id: number }>(config, "POST", "/users", {
    role: "ctr_agent",
    username,
    email: clean(contact.email)?.toLowerCase(),
    phone: normalizePhone(contact.phone),
    company_id: companyId,
    fillers: position && fillerId ? [{ filler_id: fillerId, value: position }] : [],
  });
}

// ---------------------------------------------------------------- plugin

export default defineToolPlugin({
  id: "parisa-crm",
  name: "Parisa CRM",
  description: "Create companies and contacts in Parisa CRM from photos of company cards and business cards.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "crm_check_card",
      label: "Check card in CRM",
      description:
        "Check fields you read from a photo of a company card or business card BEFORE creating anything. " +
        "Returns normalized values, format warnings (wrong length of ИНН, account, МФО) and existing companies " +
        "or contacts that look like duplicates. Saves nothing.",
      workspaceAccess: false,
      parameters: Type.Object({
        document_type: Type.Union([
          Type.Literal("company_card"),
          Type.Literal("business_card"),
          Type.Literal("other"),
        ]),
        company: companyFields,
        contacts: Type.Array(contactFields, { maxItems: 20 }),
        unclear_fields: Type.Optional(
          Type.Array(Type.String(), { description: 'Fields you could not read reliably, e.g. "company.inn"' }),
        ),
      }),
      async execute(params, config) {
        return crm(config, "POST", "/companies/recognize/check", {
          document_type: params.document_type,
          company: params.company,
          contacts: params.contacts,
          unclear_fields: params.unclear_fields ?? [],
        });
      },
    }),

    tool({
      name: "crm_create_company",
      label: "Create company in CRM",
      description:
        "Create a company with its contacts in the CRM. Call ONLY after the user explicitly confirmed the " +
        "values in this chat. Returns the CRM link.",
      workspaceAccess: false,
      parameters: Type.Object({
        company: companyFields,
        contacts: Type.Array(contactFields, { maxItems: 20 }),
      }),
      async execute({ company, contacts }, config) {
        const name = clean(company.name);
        if (!name || name.length < 3) {
          throw new CrmError("The company needs a name of at least 3 characters");
        }
        const created = await crm<{ id: number; name: string }>(config, "POST", "/companies", {
          name,
          is_old: false,
          fillers: [],
          email: clean(company.email)?.toLowerCase(),
          phone: clean(company.phone),
          inn: clean(company.inn)?.replace(/\D/g, ""),
          legal_address: clean(company.legal_address),
          bank_account: clean(company.bank_account)?.replace(/\D/g, ""),
          bank_name: clean(company.bank_name),
          mfo: clean(company.mfo)?.replace(/\D/g, ""),
          oked: clean(company.oked)?.replace(/\D/g, ""),
          director: clean(company.director),
        });

        const fillerId = contacts.length ? await positionFillerId(config) : null;
        const contactResults: { name: string | undefined; ok: boolean; error?: string }[] = [];
        for (const contact of contacts) {
          try {
            await createContact(config, created.id, contact, fillerId);
            contactResults.push({ name: clean(contact.full_name), ok: true });
          } catch (error) {
            contactResults.push({ name: clean(contact.full_name), ok: false, error: (error as Error).message });
          }
        }

        return {
          company_id: created.id,
          name: created.name,
          url: `${config.webUrl}/lists/companies/${created.id}`,
          contacts: contactResults,
        };
      },
    }),

    tool({
      name: "crm_add_contact",
      label: "Add contact to a CRM company",
      description:
        "Add a person (for example from a business card) to an EXISTING company in the CRM, found by " +
        "crm_check_card. Call ONLY after the user confirmed which company and which values.",
      workspaceAccess: false,
      parameters: Type.Object({
        company_id: Type.Integer({ minimum: 1 }),
        contact: contactFields,
      }),
      async execute({ company_id, contact }, config) {
        const fillerId = await positionFillerId(config);
        const created = await createContact(config, company_id, contact, fillerId);
        return {
          contact_id: created.id,
          company_url: `${config.webUrl}/lists/companies/${company_id}`,
          contact_url: `${config.webUrl}/lists/contacts/${created.id}`,
        };
      },
    }),
  ],
});
