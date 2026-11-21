import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  JoinColumn,
  ManyToOne,
  Index,
} from 'typeorm';
import { Company } from './company.entity';
import { ChildFillerEntity, Filler } from '../filler/filler.entity';

@Index('IDX_company_filler_company', ['company'])
@Entity()
export class CompanyFiller implements ChildFillerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Company, (company) => company.company_fillers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @ManyToOne(() => Filler, (filler) => filler.company_fillers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @Column({ type: 'varchar', length: 255 })
  value: string;

  @CreateDateColumn()
  created_at: Date;
}
