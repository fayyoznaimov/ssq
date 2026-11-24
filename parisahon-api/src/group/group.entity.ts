import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { User } from '../user/user.entity';
import { Task } from '../task/task.entity';
import { Event } from '../events/event.entity';
import { Objective } from 'src/user/dto/objective.dto';

@Entity()
export class Group {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @OneToMany(() => User, (user) => user.group)
  users: User[];

  @OneToMany(() => Task, (task) => task.group)
  assigned_tasks: Task[];

  @OneToMany(() => Event, (event) => event.target_group)
  events: Event[];

  @Column({
    type: 'jsonb',
    nullable: false,
    default: {
      monthly: 0,
      quarterly: 0,
      yearly: 0,
    },
  })
  objectives: Objective;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
