import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RoleEnum, User } from '../user/user.entity';
import * as process from 'process';
import * as bcrypt from 'bcryptjs';
import { Group } from '../group/group.entity';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { TaskType as TaskTypeEntity } from '../task_type/task_type.entity';
import { Setting } from '../setting/setting.entity';
import { DealStageCollection } from 'src/deal_stage/deal_stage.collection.entity';
import { DealStageService } from 'src/deal_stage/deal_stage.service';

@Injectable()
export class SeedService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(DealStage)
    private readonly stageRepository: Repository<DealStage>,
    @InjectRepository(TaskTypeEntity)
    private readonly taskTypeRepository: Repository<TaskTypeEntity>,
    @InjectRepository(Setting)
    private readonly settingsRepository: Repository<Setting>,
    @InjectRepository(DealStage)
    private readonly dealStageRepository: Repository<DealStage>,
    @InjectRepository(DealStageCollection)
    private readonly collectionRepository: Repository<DealStageCollection>,
  ) {}

  async seedAdminUser(): Promise<void> {
    const adminUser = await this.userRepository.findOneBy({
      email: process.env.ADMIN_EMAIL,
    });
    const salt = await bcrypt.genSalt(10);

    if (!adminUser) {
      const newAdminUser = this.userRepository.create({
        username: process.env.ADMIN_USERNAME,
        password: await bcrypt.hash(process.env.ADMIN_PASSWORD, salt),
        email: process.env.ADMIN_EMAIL,
        role: RoleEnum.ADMIN,
      });

      await this.userRepository.save(newAdminUser);
      console.log('Admin user created');
    } else {
      console.log('Admin user already exists');
    }
  }

  async seedStages(): Promise<void> {
    // Fetch all collections with stages
    const collections = await this.collectionRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.deal_stages', 't1')
      .getMany();

    const stagesToCreate: DealStage[] = [];

    // Loop through existing collections
    for (const collection of collections) {
      // Loop through deal stages of the collection
      for (const defaultStageName of DealStageService.defaultStageNames) {
        let found: boolean = false;
        // Search for default stage name
        for (const existingStage of collection.deal_stages) {
          if (defaultStageName === existingStage.name) {
            found = true;
            continue;
          }
        }

        // If not found, create one
        if (!found) {
          const newStage = new DealStage();
          newStage.name = defaultStageName;
          newStage.collection = collection;

          stagesToCreate.push(newStage);
        }
      }
    }

    // Save new default deal stages if need to
    if (stagesToCreate.length > 0) {
      console.log(`Created ${stagesToCreate.length} new default deal stages`);
      await this.dealStageRepository.save(stagesToCreate);
    } else {
      console.log('Default deal stages are populated for every collection');
    }
  }

  async fixDealStages(): Promise<void> {
    const dealStagesWithoutCollection = await this.dealStageRepository
      .createQueryBuilder('t0')
      .where('t0.collection_id IS NULl')
      .getMany();

    if (dealStagesWithoutCollection.length === 0) {
      console.log('All dealStages have collections!');
      return;
    }

    const defaultCollection = await this.collectionRepository.findOneBy({
      name: process.env.DEFAULT_COLLECTION_NAME,
    });

    for (const dealStage of dealStagesWithoutCollection) {
      dealStage.collection = defaultCollection;
    }

    await this.dealStageRepository.save(dealStagesWithoutCollection);
    console.log('Fixed deal stages without collections!');
  }

  async fixCollectionStatuses(): Promise<void> {
    const activeCollections = await this.collectionRepository.findBy({
      is_active: true,
    });

    // If there is only 1 active collection return
    if (activeCollections && activeCollections.length == 1) {
      console.log('Collections statuses are fine!');
      return;
    }
    const defaultCollection = await this.collectionRepository.findOneBy({
      name: process.env.DEFAULT_COLLECTION_NAME,
    });

    // If no active collections, set default collection as active
    if (activeCollections && activeCollections.length === 0) {
      if (defaultCollection) {
        defaultCollection.is_active = true;

        await this.collectionRepository.save(defaultCollection);
        console.log('Default collection is set as active!');
        return;
      }
    }

    if (activeCollections && activeCollections.length > 1) {
      if (defaultCollection) {
        for (const activeCollection of activeCollections) {
          activeCollection.is_active = false;
        }
        defaultCollection.is_active = true;

        await this.collectionRepository.save([
          defaultCollection,
          ...activeCollections,
        ]);
        console.log(
          'Default collection is set as active, the rest is set as inactive!',
        );
        return;
      }
    }
  }

  async seedDefaultCollection(): Promise<void> {
    const defaultCollection = await this.collectionRepository.findOneBy({
      name: process.env.DEFAULT_COLLECTION_NAME,
    });

    if (defaultCollection) {
      console.log('Default Collection already exists!');
      return;
    }

    const newCollection = new DealStageCollection();
    newCollection.name = process.env.DEFAULT_COLLECTION_NAME;
    newCollection.is_active = true;

    await this.collectionRepository.save(newCollection);
    console.log('Populated default collection');
  }

  async seedTaskTypes(): Promise<void> {
    const taskTypes = ['Встреча', 'Связаться'];

    const existingTaskTypes = await this.taskTypeRepository.findBy({
      name: In(taskTypes),
    });

    const newTaskTypes: TaskTypeEntity[] = [];

    taskTypes.forEach((taskType) => {
      if (
        !existingTaskTypes.some(
          (existingTaskType) => existingTaskType.name === taskType,
        )
      ) {
        const newTaskType = new TaskTypeEntity();
        newTaskType.name = taskType;
        newTaskTypes.push(newTaskType);
      }
    });

    await this.taskTypeRepository.save(newTaskTypes);
    console.log('Created Task Types: ', newTaskTypes);
  }

  async seedGroups(): Promise<void> {
    const groupNames = ['Sales', 'IT', 'Management'];

    const groups = await this.groupRepository.findBy({ name: In(groupNames) });
    if (groups.length === 0) {
      const newGroups = this.groupRepository.create([
        { name: groupNames[0] },
        { name: groupNames[1] },
        { name: groupNames[2] },
      ]);

      await this.groupRepository.save(newGroups);
      console.log('Default groups created');
    } else {
      console.log('Default groups already exist');
    }
  }

  async seedSettings(): Promise<void> {
    const settings = await this.settingsRepository.find({
      relations: ['default_stage', 'default_agent'],
      order: {
        id: 'DESC',
      },
      take: 1,
    });

    if (settings.length == 0) {
      const newSettings = new Setting();
      newSettings.default_stage = await this.stageRepository.findOneBy({
        name: process.env.DEAL_STAGE_CREATED,
      });

      await this.settingsRepository.save(newSettings);
      console.log('Default settings created');
    }

    console.log('Default settings are exist!');
  }
}
