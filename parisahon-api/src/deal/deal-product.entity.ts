import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
  Check,
} from 'typeorm';
import { Deal } from './deal.entity';
import { Product } from '../product/product.entity';
import { decimalText } from './decimal';

/**
 * Creating a separate entity for many to many relationship to gain better control over data
 */
@Index('IDX_deal_product_deal', ['deal'])
@Check('CHK_deal_product_amounts', `"quantity" >= 0 AND "price" >= 0`)
@Entity({ name: 'deal_product' })
export class DealProduct {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, (deal) => deal.deal_products, {
    onDelete: 'CASCADE',
    // A product removed from a deal is deleted, not left behind with deal_id = NULL
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => Product, (product) => product.deal_products, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  /** metres, kilos, pieces: numeric(14,3), given as text ("12.5"): decimal.ts */
  @Column({ type: 'numeric', precision: 14, scale: 3, nullable: false, transformer: decimalText })
  quantity: number;

  /** the price of one unit, numeric(18,2), given as text ("1250.75") */
  @Column({ type: 'numeric', precision: 18, scale: 2, nullable: false, transformer: decimalText })
  price: number;
}
