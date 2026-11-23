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

  /**
   * The first admin of an empty CRM, from .env (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_USERNAME).
   * Only when the database has no live admin at all: renaming or deleting that account in the CRM
   * must not bring it back with the password from the file at the next start (the last admin cannot
   * be deleted or demoted, so this is the way back in only for an empty or broken database).
   * Never stops the API.
   */
  async seedAdminUser(): Promise<void> {
    try {
      // soft-deleted accounts are not counted
      if ((await this.userRepository.countBy({ role: RoleEnum.ADMIN })) > 0) {
        console.log('Admin user already exists');
        return;
      }
      const email = (process.env.ADMIN_EMAIL || '').trim();
      const password = process.env.ADMIN_PASSWORD || '';
      if (!email || !password) {
        console.warn('No admin in the database and no ADMIN_EMAIL / ADMIN_PASSWORD in the environment: no admin created');
        return;
      }
      // a live account with this e-mail (in any case) is not doubled; a deleted one does not hold its
      // e-mail any more (the unique index IDX_user_email_active covers live accounts only)
      const taken = await this.userRepository
        .createQueryBuilder('u')
        .where('lower(u.email) = lower(:email)', { email })
        .getOne();
      if (taken) {
        console.warn(`No admin in the database, and ${email} belongs to account ${taken.id} (${taken.role}): no admin created`);
        return;
      }
      await this.userRepository.save(
        this.userRepository.create({
          username: process.env.ADMIN_USERNAME || 'admin',
          password: await bcrypt.hash(password, await bcrypt.genSalt(10)),
          email,
          role: RoleEnum.ADMIN,
        }),
      );
      console.log('Admin user created');
    } catch (error) {
      console.error(`Admin user seed failed, the API starts anyway: ${(error as Error)?.message ?? error}`);
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

  /** The default groups of an empty CRM only: groups the admin deleted do not come back at the next start. */
  async seedGroups(): Promise<void> {
    const groupNames = ['Sales', 'IT', 'Management'];

    if ((await this.groupRepository.count()) === 0) {
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
