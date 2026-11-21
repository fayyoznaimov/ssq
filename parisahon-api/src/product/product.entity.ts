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

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToMany(() => DealProduct, (dealProduct) => dealProduct.product)
  deal_products: DealProduct[];

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

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
