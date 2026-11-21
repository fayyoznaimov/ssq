import { EventDto } from './event.dto';
import { Company } from '../../company/company.entity';

export class CompanyEventDto extends EventDto {
  company: Company;
}
