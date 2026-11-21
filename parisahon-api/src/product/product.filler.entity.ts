import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Product } from './product.entity';
import { ChildFillerEntity, Filler } from '../filler/filler.entity';

@Index('IDX_product_filler_product', ['product'])
@Entity()
export class ProductFiller implements ChildFillerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255, nullable: false })
  value: string;

  @ManyToOne(() => Product, (product) => product.product_fillers, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => Filler, (filler) => filler.product_fillers, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @CreateDateColumn()
  created_at: Date;
}
