import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Group } from 'src/group/group.entity';
import { RoleEnum, User } from 'src/user/user.entity';
import { Repository } from 'typeorm';
import { UpsertObjectivesDto } from './dto/create.objective.dto';
import { HelperService } from 'src/helper/helper.service';
import { ResultsObjectiveQuery } from './dto/results.objective.dto';
import { Deal } from 'src/deal/deal.entity';
import { periodBounds } from 'src/analytics/period';

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
   * (DEAL_STAGE_CLOSED) and `closed_at` inside the period. Open deals, deals
   * closed without success and deleted deals do not count. The old version
   * summed every non-cancelled deal by creation date, open ones included.
   *
   * Every group and every staff member is listed, with 0 when nothing was
   * closed, so a plan without a fact is visible too.
   */
  async fetchObjectiveResults(
    query: ResultsObjectiveQuery,
  ): Promise<Record<string, any>> {
    const period = periodBounds(query);

    // Groups with their staff (contacts of clients are not employees)
    const groups = await this.groupRepository
      .createQueryBuilder('t0')
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
      .where('t1.name = :won_stage', { won_stage: process.env.DEAL_STAGE_CLOSED })
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

    const result = groups.map((group) => {
      const users = (group.users ?? []).map((user) => {
        const fact = factByUser.get(user.id);
        return {
          id: user.id,
          username: user.username,
          objectives: user.objectives,
          total_budget: fact ? fact.total_budget : 0,
          deal_count: fact ? fact.deal_count : 0,
        };
      });

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

    return { groups: result };
  }
}
