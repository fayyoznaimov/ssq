import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { instanceToPlain } from 'class-transformer';
import { DealTrashService } from './deal-trash.service';
import { SearchDealTrashDto } from './dto/search.deal.trash.dto';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

/**
 * The trash of deals (see DealTrashService). Deals get here through DELETE /deals/:id.
 *
 * Registered in DealModule BEFORE DealController: "/deals/trash" would otherwise be taken
 * by GET/DELETE "/deals/:id" (ParseIntPipe answers 400 for "trash").
 */
@Controller('deals/trash')
export class DealTrashController {
  constructor(private readonly dealTrashService: DealTrashService) {}

  /** Deals in the trash the user may restore: ?search=&limit=&skip=&sort[deleted_at]=-1 */
  @Get()
  async list(
    @Query() query: SearchDealTrashDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.dealTrashService.list(request['user'], query),
    );
  }

  @Post(':id/restore')
  async restore(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.dealTrashService.restore(request['user'], id),
    );
  }

  /** Deletes one deal of the trash for good (admin) */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete(':id')
  async purge(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.dealTrashService.purge(id);
  }

  /** Empties the trash (admin) */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete()
  async purgeAll(): Promise<{ deleted: number }> {
    return this.dealTrashService.purgeAll();
  }
}
