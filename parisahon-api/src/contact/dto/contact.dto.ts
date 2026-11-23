export enum ContactTypes {
  COMPANY = 'company',

  CTR_AGENT = 'ctr_agent',
}

export class ContactCompanyDto {
  id: number;

  name: string;
}

export class ContactDto {
  id: number;

  name: string;

  company?: ContactCompanyDto;

  phones: string[];

  emails: string[];

  type: ContactTypes;

  // the responsible manager of the latest deal of the contact (company)
  agent?: { id: number; username: string } | null;

  // «Последнее касание»: the latest event of the contact (company) or of its deals
  last_activity_at?: Date | string | null;

  created_at?: Date;
}

export class ContactRowDto {
  type: string;

  id: number;

  name: string;

  email?: string;

  phone?: string;

  company_id?: number;

  company_name?: string;

  created_by?: number;

  created_at?: Date;

  updated_by?: number;

  updated_at?: Date;
}
