import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Deal } from './deal.entity';
import { Product } from '../product/product.entity';

/**
 * Creating a separate entity for many to many relationship to gain better control over data
 */
@Index('IDX_deal_product_deal', ['deal'])
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

  @Column({ type: 'bigint', nullable: false })
  quantity: number;

  @Column({ type: 'bigint', nullable: false })
  price: number;
}
