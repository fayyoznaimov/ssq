import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { User } from '../user/user.entity';

@Entity()
export class Setting {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => DealStage, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'default_stage_id' })
  default_stage: DealStage;

  @ManyToOne(() => User, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  default_agent: User;

  // the company's e-mail signature template: HTML with {{name}}, {{phone}}, {{email}} (sanitised on save)
  @Column({ type: 'text', nullable: true })
  mail_signature: string | null;
}
