import { BadRequestException, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { HelperService } from '../helper/helper.service';
import { UpdateSettingDto } from './dto/update.setting.dto';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { RoleEnum, User } from '../user/user.entity';

@Injectable()
export class SettingService {
  constructor(
    @InjectRepository(Setting)
    private settingRepository: Repository<Setting>,
    private helperService: HelperService,
  ) {}

  async fetchSettings(): Promise<Setting> {
    const settings = await this.settingRepository.find({
      relations: ['default_stage', 'default_agent'],
      order: {
        id: 'DESC',
      },
      take: 1,
    });

    return settings[0];
  }

  async update(data: UpdateSettingDto): Promise<void> {
    const settings = await this.settingRepository.find({
      order: {
        id: 'DESC',
      },
      take: 1,
    });

    const setting: Setting = settings[0];

    if (data.default_stage_id) {
      setting.default_stage = await this.helperService.getById(
        DealStage,
        data.default_stage_id,
      );
    }

    if (data.default_agent_id) {
      setting.default_agent = await this.helperService.getById(
        User,
        data.default_agent_id,
      );

      if (setting.default_agent.role !== RoleEnum.AGENT) {
        throw new BadRequestException(
          `User with id: ${setting.default_agent.id} is not an agent!`,
        );
      }
    }

    await this.settingRepository.save(setting);
    return;
  }
}
