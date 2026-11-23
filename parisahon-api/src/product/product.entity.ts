import {
  Column,
  CreateDateColumn, DeleteDateColumn,
  Entity, JoinColumn, ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ProductFiller } from './product.filler.entity';
import { DealProduct } from '../deal/deal-product.entity';
import { User } from '../user/user.entity';

/** numeric comes from Postgres as text: the API gives a number (null stays null). */
const decimal = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null || value === undefined ? null : Number(value)),
};

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToMany(() => DealProduct, (dealProduct) => dealProduct.product)
  deal_products: DealProduct[];

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  // артикул: what the factory and 1C call the product
  @Column({ type: 'varchar', length: 64, nullable: true })
  sku: string | null;

  // единица: м, кг, шт, рулон ...
  @Column({ type: 'varchar', length: 32, nullable: true })
  unit: string | null;

  // the base price of one unit (the deal takes it as a suggestion); in the currency of the CRM
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, transformer: decimal })
  price: number | null;

  @OneToMany(() => ProductFiller, (productFiller) => productFiller.product, {
    cascade: true,
  })
  product_fillers: ProductFiller[];

  @ManyToOne(() => User, (user) => user.created_products)
  @JoinColumn({ name: 'created_by' })
  created_by: User;

  @ManyToOne(() => User, (user) => user.updated_products)
  @JoinColumn({ name: 'updated_by' })
  updated_by: User;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at: Date;

  @CreateDateColumn()
  created_at: Date;
}
