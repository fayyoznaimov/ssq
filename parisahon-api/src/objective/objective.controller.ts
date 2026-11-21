import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ObjectiveService } from './objective.service';
import { ResultsObjectiveQuery } from './dto/results.objective.dto';
import { UpsertObjectivesDto } from './dto/create.objective.dto';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

@Roles(AuthGuard.MANAGER_LEVEL)
@Controller('analytics/objectives')
export class ObjectiveController {
  constructor(private objectiveService: ObjectiveService) {}

  @Get('/results')
  async fetchResults(
    @Query() query: ResultsObjectiveQuery,
  ): Promise<Record<string, any>> {
    return this.objectiveService.fetchObjectiveResults(query);
  }

  @Get()
  async fetchObjectives(): Promise<Record<string, any>> {
    return this.objectiveService.fetchObjectives();
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch()
  async upsertObjectives(@Body() data: UpsertObjectivesDto): Promise<void> {
    return this.objectiveService.upsertObjectives(data);
  }
}
