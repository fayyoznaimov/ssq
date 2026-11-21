import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DealStageService } from './deal_stage.service';
import { DealStage } from './deal_stage.entity';
import { CreateDealStageDto } from './dto/create.deal.stage.dto';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { CreateCollectionDto } from './dto/create.collection.dto';
import { DealStageCollection } from './deal_stage.collection.entity';
import { FetchQueryDto } from './dto/fetch.query.dto';
import { DeleteStageQueryDto } from './dto/delete.stage.query.dto';

@UseGuards(AuthGuard)
@Controller('stages')
export class DealStageController {
  constructor(private dealStageService: DealStageService) {}

  @Get()
  async findAll(@Query() query: FetchQueryDto): Promise<DealStage[]> {
    return this.dealStageService.fetchAll(query);
  }

  @Get('collections')
  async getCollections(
  ): Promise<Record<string, any>> {
    return this.dealStageService.getCollections();
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post()
  async create(@Body() data: CreateDealStageDto): Promise<DealStage> {
    return this.dealStageService.create(data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post('collections')
  async createCollection(
    @Body() data: CreateCollectionDto,
  ): Promise<DealStageCollection> {
    return this.dealStageService.createCollection(data);
  }

  @Get("collections/:id")
  async findCollectionById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DealStageCollection> {
    return this.dealStageService.getCollectionById(id);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch('collections/:id')
  async updateCollection(
    @Body() data: CreateCollectionDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.dealStageService.updateCollection(id, data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch('collections/:id/activate')
  async activateCollection(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.dealStageService.activateCollection(id);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete('collections/:id')
  async deleteCollection(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.dealStageService.deleteCollection(id);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch(':id')
  async update(
    @Body() data: CreateDealStageDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.dealStageService.update(id, data);
  }

  /**
   * ?move_to=<stage id> moves deals and stage history of the deleted stage
   * to another stage of the same collection.
   */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: DeleteStageQueryDto,
  ): Promise<void> {
    return this.dealStageService.delete(id, query.move_to);
  }
}
