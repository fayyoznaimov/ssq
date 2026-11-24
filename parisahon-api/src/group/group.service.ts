import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Group } from './group.entity';
import { DataSource, Repository } from 'typeorm';
import { CreateGroupDto } from './dto/create.group.dto';
import { RoleEnum } from '../user/user.entity';
import { AuditJournal } from '../audit/audit-journal';

/** TypeORM answers [rows, count] to UPDATE ... RETURNING on Postgres. */
function updatedRows(result: any): any[] {
  return Array.isArray(result?.[0]) ? result[0] : Array.isArray(result) ? result : [];
}

/** GET /groups/:id/usage: what deleting the group affects. */
export interface GroupUsage {
  id: number;
  name: string;
  /** staff accounts in the group (not deleted): their "Для группы" rights cover the group's deals */
  users: number;
  /** tasks assigned to the group and not done yet */
  open_tasks: number;
  /** every task assigned to the group, done ones included */
  tasks: number;
}

@Injectable()
export class GroupService {
  constructor(
    @InjectRepository(Group)
    private groupRepository: Repository<Group>,
    private dataSource: DataSource,
  ) {}

  async findById(id: number): Promise<Group> {
    const group = await this.groupRepository.findOneBy({ id });

    if (!group) {
      throw new NotFoundException(`Group with id ${id} does not exist!`);
    }

    return group;
  }

  /**
   * Every group by name, with `users_count`: its staff accounts that are not deleted (the column «Участников»
   * of the list «Группы»; the «Для группы» rights of an employee cover the deals of exactly these people).
   */
  async fetchAll(): Promise<(Group & { users_count: number })[]> {
    const groups = await this.groupRepository.find({ order: { name: 'ASC', id: 'ASC' } });
    const counts: { group_id: number; n: number }[] = await this.dataSource.query(
      `SELECT group_id, count(*)::int AS n FROM "user"
        WHERE group_id IS NOT NULL AND deleted_at IS NULL AND role <> $1 GROUP BY group_id`,
      [RoleEnum.CTR_AGENT],
    );
    const byGroup = new Map(counts.map((row) => [Number(row.group_id), Number(row.n)]));
    return groups.map((group) => Object.assign(group, { users_count: byGroup.get(group.id) ?? 0 }));
  }

  /**
   * POST /groups/:id/members/:user_id: the employee (a staff account, not deleted) moves into the group, from
   * another group or none. Their «Для группы» rights follow the new group at once (AuthGuard reads group_id
   * on every request).
   */
  async addMember(id: number, userId: number): Promise<void> {
    await this.findById(id);
    // the journal (src/audit): «Изменение прав — Группа: … → …» of the employee
    const moved = updatedRows(
      await AuditJournal.around(this.dataSource, 'user', 't.id = $1', [userId], () =>
        this.dataSource.query(
          `UPDATE "user" SET group_id = $1, updated_at = now()
            WHERE id = $2 AND deleted_at IS NULL AND role <> $3 RETURNING id`,
          [id, userId, RoleEnum.CTR_AGENT],
        ),
      ),
    );
    if (!moved.length) throw new NotFoundException(`Сотрудник ${userId} не найден`);
  }

  /**
   * DELETE /groups/:id/members/:user_id: the employee leaves the group and stays without one (their «Для группы»
   * rights cover only their own records then) until their card gets another group.
   */
  async removeMember(id: number, userId: number): Promise<void> {
    await this.findById(id);
    const removed = updatedRows(
      await AuditJournal.around(this.dataSource, 'user', 't.id = $1', [userId], () =>
        this.dataSource.query(
          `UPDATE "user" SET group_id = NULL, updated_at = now()
            WHERE id = $2 AND group_id = $1 AND deleted_at IS NULL AND role <> $3 RETURNING id`,
          [id, userId, RoleEnum.CTR_AGENT],
        ),
      ),
    );
    if (!removed.length) throw new NotFoundException(`Сотрудника ${userId} нет в этой группе`);
  }

  async create(data: CreateGroupDto): Promise<Group> {
    const name = await this.freeName(data.name);

    const newGroup = new Group();
    newGroup.name = name;

    return this.groupRepository.save(newGroup);
  }

  /** Renames the group: the name only (objectives are set on the goals page), unique like a new one. */
  async update(id: number, data: CreateGroupDto): Promise<void> {
    await this.findById(id);
    await this.groupRepository.update(id, { name: await this.freeName(data.name, id) });
  }

  async usage(id: number): Promise<GroupUsage> {
    const group = await this.findById(id);
    const [row] = await this.dataSource.query(
      `SELECT
         (SELECT count(*) FROM "user" u WHERE u.group_id = $1 AND u.deleted_at IS NULL AND u.role <> 'ctr_agent')::int AS users,
         (SELECT count(*) FROM task t WHERE t.group_id = $1 AND t.closed_at IS NULL)::int AS open_tasks,
         (SELECT count(*) FROM task t WHERE t.group_id = $1)::int AS tasks`,
      [id],
    );
    return { id: group.id, name: group.name, users: row.users, open_tasks: row.open_tasks, tasks: row.tasks };
  }

  /**
   * Deletes the group. A group with staff or open tasks is deleted only together with moving them
   * (`moveTo`: another group): the staff would silently lose their "Для группы" rights and the tasks
   * their assignee (the foreign keys are ON DELETE SET NULL). Done tasks keep no group; the group's
   * objectives are deleted with it.
   */
  async delete(id: number, moveTo?: number): Promise<void> {
    const usage = await this.usage(id);

    if (moveTo !== undefined) {
      if (moveTo === id) {
        throw new BadRequestException('Выберите другую группу для переноса');
      }
      await this.findById(moveTo);
    } else if (usage.users > 0 || usage.open_tasks > 0) {
      throw new ConflictException(
        `В группе «${usage.name}» сотрудников: ${usage.users}, открытых задач: ${usage.open_tasks}. ` +
          'Выберите группу, в которую их перенести, или переведите их вручную.',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      if (moveTo !== undefined) {
        // the journal (src/audit): every moved employee gets «Группа: … → …»
        await AuditJournal.around(manager, 'user', 't.group_id = $1', [id], () =>
          manager.query(`UPDATE "user" SET group_id = $2 WHERE group_id = $1`, [id, moveTo]),
        );
        await manager.query(`UPDATE task SET group_id = $2 WHERE group_id = $1 AND closed_at IS NULL`, [id, moveTo]);
      }
      await manager.delete(Group, id);
    });
  }

  /** The trimmed name, or 400 when another group has it already (case does not matter). */
  private async freeName(raw: string, exceptId?: number): Promise<string> {
    const name = String(raw ?? '').trim();
    if (name.length < 3) {
      throw new BadRequestException('Название группы: от 3 символов');
    }
    const qb = this.groupRepository
      .createQueryBuilder('g')
      .where('lower(g.name) = lower(:name)', { name });
    if (exceptId !== undefined) qb.andWhere('g.id <> :id', { id: exceptId });
    if ((await qb.getCount()) > 0) {
      throw new BadRequestException('Группа с таким названием уже есть');
    }
    return name;
  }
}
