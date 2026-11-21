import { extname } from 'path';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { User } from '../user/user.entity';
import { Email } from '../email/email.entity';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';

@Index('IDX_file_email', ['email'])
@Entity()
export class File {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  path: string;

  @Column({ type: 'bigint', default: 0 })
  size: number;

  @Column({ type: 'varchar', length: 255, default: WhichFiles.FROM_EMAILS })
  from: WhichFiles;

  @Column({ type: 'varchar', length: 255, nullable: true })
  extension: string;

  @ManyToMany(() => Deal, (deal) => deal.files)
  @JoinTable({ name: 'deal_file' })
  deals: Deal[];

  @ManyToOne(() => Email, (email) => email.files, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'email_id' })
  email: Email;

  @ManyToOne(() => User, (user) => user.uploaded_files, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'uploaded_by' })
  uploaded_by: User;

  @CreateDateColumn()
  created_at: Date;

  /** ".pdf": lower case with the dot; null for none or garbage */
  static extensionOf(name: string): string | null {
    const extension = extname(name ?? '').toLowerCase();
    return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : null;
  }

  // creators that do not set it (files of a sent e-mail): the "Тип" column and the filters need it
  @BeforeInsert()
  fillExtension(): void {
    this.extension = this.extension || File.extensionOf(this.name);
  }
}
