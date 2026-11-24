import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Check,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { CompanyFiller } from '../company/company.filler.entity';
import { UserFiller } from '../user/user.filler.entity';
import { DealFiller } from '../deal/deal.filler.entity';
import { ProductFiller } from '../product/product.filler.entity';

/**
 * Fillers purpose is to enable dynamic field creation for other entities.
 * This table was created, because business logic requires the dynamically created fields
 * to be universal across all deals, companies, users.
 *
 * This table represents the field name, while CompanyFiller/UserFiller/DealFiller/ProductFiller represent values.
 * A field with values is not deleted by the database (their filler_id is ON DELETE RESTRICT): FillerService.delete
 * deletes the values first.
 */
// one of FillableTablesEnum: migration 1795722000000-child-keys-checks
@Check('CHK_filler_target', `"target" IN ('company', 'deal', 'user', 'product')`)
@Entity()
export class Filler {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  target: string;

  @Column({ type: 'varchar', length: 255 })
  field: string;

  @Column({ type: 'boolean', default: false, name: 'is_required' })
  is_required: boolean;

  @OneToMany(() => CompanyFiller, (companyFiller) => companyFiller.filler)
  company_fillers: CompanyFiller[];

  @OneToMany(() => UserFiller, (userFiller) => userFiller.filler)
  user_fillers: UserFiller[];

  @OneToMany(() => DealFiller, (dealFiller) => dealFiller.filler)
  deal_fillers: DealFiller[];

  @OneToMany(() => ProductFiller, (productFiller) => productFiller.filler)
  product_fillers: ProductFiller[];

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}

export interface ChildFiller {
  filler_id: number;
  value: string;
}

/**
 * The only difference between this interface and ChildFiller
 * is that filler is an entity instead of filler_id which is number
 */
export interface ChildFillerEntity {
  filler: Filler;
  value: string;
}

export enum FillableTablesEnum {
  COMPANY = 'company',
  DEAL = 'deal',
  USER = 'user',
  PRODUCT = 'product',
}
