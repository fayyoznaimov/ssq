import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
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
 */
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

  @CreateDateColumn()
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
