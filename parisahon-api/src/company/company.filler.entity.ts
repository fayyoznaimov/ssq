import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  JoinColumn,
  ManyToOne,
  Index,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { Company } from './company.entity';
import { ChildFillerEntity, Filler } from '../filler/filler.entity';

@Index('IDX_company_filler_company', ['company'])
@Entity()
export class CompanyFiller implements ChildFillerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Company, (company) => company.company_fillers, {
    onDelete: 'CASCADE',
    // NOT NULL (migration 1795722000000-child-keys-checks); a value dropped from its owner's list is deleted
    nullable: false,
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  // a value without its field is meaningless and a field with values is not deleted by the database
  // (ON DELETE RESTRICT, migration 1795721000000-delete-rules): DELETE /fillers/:id removes the values itself
  @ManyToOne(() => Filler, (filler) => filler.company_fillers, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @Column({ type: 'varchar', length: 255 })
  value: string;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
