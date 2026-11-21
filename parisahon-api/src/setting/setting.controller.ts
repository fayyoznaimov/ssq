import { Body, Controller, Get, Patch } from '@nestjs/common';
import { SettingService } from './setting.service';
import { UpdateSettingDto } from './dto/update.setting.dto';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { instanceToPlain } from 'class-transformer';

@Controller('settings')
export class SettingController {
  constructor(private settingService: SettingService) {}

  // read by the deal screens of every staff role
  @Get()
  async fetchSettings(): Promise<Record<string, any>> {
    return instanceToPlain(this.settingService.fetchSettings());
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch()
  async updateSettings(@Body() data: UpdateSettingDto): Promise<void> {
    return this.settingService.update(data);
  }
}
