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
import { ChildFillerEntity, Filler } from '../filler/filler.entity';
import { User } from './user.entity';

@Index('IDX_user_filler_user', ['user'])
@Entity()
export class UserFiller implements ChildFillerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.user_fillers, {
    onDelete: 'CASCADE',
    // NOT NULL (migration 1795722000000-child-keys-checks); a value dropped from its owner's list is deleted
    nullable: false,
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // a value without its field is meaningless and a field with values is not deleted by the database
  // (ON DELETE RESTRICT, migration 1795721000000-delete-rules): DELETE /fillers/:id removes the values itself
  @ManyToOne(() => Filler, (filler) => filler.user_fillers, {
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
