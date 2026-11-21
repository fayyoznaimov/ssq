import { Company } from 'src/company/company.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class Notification {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  message: string;

  @Column()
  company_id: number;

  @ManyToOne(() => Company, (company) => company.notifications)
  @JoinColumn({ name: 'company_id' })
  company: Company;
}
