import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Group } from 'src/group/group.entity';
import { RoleEnum, User } from 'src/user/user.entity';
import { In, Repository } from 'typeorm';
import { UpsertObjectivesDto } from './dto/create.objective.dto';
import { HelperService } from 'src/helper/helper.service';
import { ResultsObjectiveQuery } from './dto/results.objective.dto';
import { Deal } from 'src/deal/deal.entity';
import { periodBounds } from 'src/analytics/period';
import { StageKind } from 'src/deal_stage/stage-kind';

@Injectable()
export class ObjectiveService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Group)
    private groupRepository: Repository<Group>,
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    private helperService: HelperService,
  ) {}

  async fetchObjectives(): Promise<Record<string, any>> {
    return this.groupRepository
      .createQueryBuilder('t0')
      .select('t0.objectives')
      .addSelect('t0.id')
      .addSelect('t0.name')
      .leftJoin('t0.users', 't1', 't1.role != :ctr_agent', {
        ctr_agent: RoleEnum.CTR_AGENT,
      })
      .addSelect('t1.id')
      .addSelect('t1.username')
      .addSelect('t1.objectives')
      .orderBy('t0.id', 'ASC')
      .addOrderBy('t1.username', 'ASC')
      .getMany();
  }

  async upsertObjectives(data: UpsertObjectivesDto): Promise<void> {
    // Extract group ids
    const groupIds: number[] = [];
    for (const groupObjective of data.data) {
      groupIds.push(groupObjective.id);
    }

    // Fetch groups with users
    const groups = await this.groupRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.users', 't1')
      .where('t0.id IN (:...group_ids)', { group_ids: groupIds })
      .getMany();

    const groupsMap = this.helperService.createHashMap(groups);

    // Groups for update
    const groupsForUpdate: Group[] = [];
    // Users for update
    const usersForUpdate: User[] = [];

    // Loop through groups and update entities
    for (const groupObjective of data.data) {
      if (!groupsMap.has(groupObjective.id)) {
        throw new NotFoundException(
          `Groupd with id ${groupObjective.id} does not exist!`,
        );
      }

      // Update group objective
      const group = groupsMap.get(groupObjective.id);
      group.objectives = groupObjective.objectives;

      // Add group to update list
      groupsForUpdate.push(group);

      const userMap = this.helperService.createHashMap(group.users);

      // Loop through group users and update entities
      for (const userObjective of groupObjective.users) {
        if (!userMap.has(userObjective.id)) {
          throw new NotFoundException(
            `User with id ${userObjective.id} does not exist!`,
          );
        }

        // Update user objective
        const user = userMap.get(userObjective.id);
        user.objectives = userObjective.objectives;

        // Add user to update list
        usersForUpdate.push(user);
      }
    }

    // Save updates to db
    await this.groupRepository.save(groupsForUpdate);
    if (usersForUpdate.length > 0) {
      await this.userRepository.save(usersForUpdate);
    }
  }

  /**
   * Plan vs. fact per group and employee.
   *
   * Fact = budget of the deals the employee is responsible for that were
   * closed successfully in the period: stage "УСПЕШНО РЕАЛИЗОВАНО"
   * (deal_stage.kind = won) and `closed_at` inside the period. Open deals, deals
   * closed without success and deleted deals do not count. The old version
   * summed every non-cancelled deal by creation date, open ones included.
   *
   * Every group and every staff member is listed, with 0 when nothing was
   * closed, so a plan without a fact is visible too. An employee who has left
   * (deleted account) stays in the group for the periods with their sales: the
   * group's fact of a past month no longer shrinks when someone leaves. Sales of
   * staff in no group come as the group "Вне групп" (id null, no plan).
   */
  async fetchObjectiveResults(
    query: ResultsObjectiveQuery,
  ): Promise<Record<string, any>> {
    const period = periodBounds(query);

    // Groups with their staff (contacts of clients are not employees); deleted
    // accounts too, they are dropped below unless they sold in the period
    const groups = await this.groupRepository
      .createQueryBuilder('t0')
      .withDeleted()
      .leftJoinAndSelect('t0.users', 't1', 't1.role != :ctr_agent', {
        ctr_agent: RoleEnum.CTR_AGENT,
      })
      .orderBy('t0.id', 'ASC')
      .addOrderBy('t1.username', 'ASC')
      .getMany();

    // Successfully closed budget per responsible employee
    const facts = await this.dealRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.stage', 't1')
      .select('t0.agent_id', 'user_id')
      .addSelect('COALESCE(SUM(t0.budget), 0)', 'total_budget')
      .addSelect('COUNT(t0.id)', 'deal_count')
      .where('t1.kind = :won_stage', { won_stage: StageKind.WON })
      .andWhere('t0.closed_at IS NOT NULL')
      .andWhere('t0.closed_at >= :from_date AND t0.closed_at <= :till_date')
      .andWhere('t0.agent_id IS NOT NULL')
      .setParameters(period)
      .groupBy('t0.agent_id')
      .getRawMany();

    const factByUser = new Map<number, { total_budget: number; deal_count: number }>();
    for (const row of facts) {
      factByUser.set(+row.user_id, {
        total_budget: +row.total_budget,
        deal_count: +row.deal_count,
      });
    }

    const row = (user: User) => {
      const fact = factByUser.get(user.id);
      return {
        id: user.id,
        username: user.username,
        objectives: user.objectives,
        total_budget: fact ? fact.total_budget : 0,
        deal_count: fact ? fact.deal_count : 0,
        deleted: !!user.deleted_at,
      };
    };
    const listed = (user: User) => !user.deleted_at || factByUser.has(user.id);

    const result: Record<string, any>[] = groups.map((group) => {
      const users = (group.users ?? []).filter(listed).map(row);

      const total_budget = users.reduce((sum, u) => sum + u.total_budget, 0);

      return {
        id: group.id,
        name: group.name,
        objectives: group.objectives,
        // the old (misspelled) key, kept for older clients
        objetives: group.objectives,
        total_budget,
        users,
      };
    });

    // sales of staff who are in no group: counted too, as a group without a plan
    const grouped = new Set(groups.flatMap((group) => (group.users ?? []).map((user) => user.id)));
    const outside = [...factByUser.keys()].filter((id) => !grouped.has(id));
    if (outside.length) {
      const people = await this.userRepository.find({
        where: { id: In(outside) },
        withDeleted: true,
        order: { username: 'ASC' },
      });
      const users = people.filter((user) => user.role !== RoleEnum.CTR_AGENT).map(row);
      if (users.length) {
        result.push({
          id: null,
          name: 'Вне групп',
          objectives: null,
          objetives: null,
          total_budget: users.reduce((sum, u) => sum + u.total_budget, 0),
          users,
        });
      }
    }

    return { groups: result };
  }
}
