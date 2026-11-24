import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { TIME } from '../helper/time-column';
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
    // a value dropped from the product's list is deleted (its product_id cannot be NULL)
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  // a value without its field is meaningless and a field with values is not deleted by the database
  // (ON DELETE RESTRICT, migration 1795721000000-delete-rules): DELETE /fillers/:id removes the values itself
  @ManyToOne(() => Filler, (filler) => filler.product_fillers, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
