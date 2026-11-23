import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { FillerService } from './filler.service';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { Filler } from './filler.entity';
import { UpdateFillerDto } from './dto/update.filler.dto';

@Controller('fillers')
export class FillerController {
  constructor(private fillerService: FillerService) {}

  @Get()
  async findAll(): Promise<Record<string, any[]>> {
    return this.fillerService.fetchAll();
  }

  /** How many records have a value of the field: the web shows it before the field is deleted. */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Get(':id/usage')
  async usage(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ id: number; field: string; target: string; values: number }> {
    return this.fillerService.usage(id);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post()
  async create(@Body() data: UpdateFillerDto): Promise<Filler> {
    return this.fillerService.create(data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch(':id')
  async update(
    @Body() data: UpdateFillerDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.fillerService.update(id, data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.fillerService.delete(id);
  }
}
