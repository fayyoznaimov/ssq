import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEnum, User } from '../user/user.entity';
import * as process from 'process';
import * as bcrypt from 'bcryptjs';
import { Group } from '../group/group.entity';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { TaskType as TaskTypeEntity } from '../task_type/task_type.entity';
import { Setting } from '../setting/setting.entity';
import { DealStageCollection } from 'src/deal_stage/deal_stage.collection.entity';
import {
  defaultStageName,
  legacyKindOfName,
  StageKind,
  SYSTEM_STAGE_KINDS,
} from 'src/deal_stage/stage-kind';

/**
 * The start-up steps main.ts runs one by one (every seed* and fix* method of the class) log their error
 * instead of throwing it: one broken step (a renamed or deleted default, an unexpected row, a database
 * error) must not stop the API — the server would restart it in a loop and the CRM would stay down.
 */
function NonFatalSteps(): ClassDecorator {
  return (target) => {
    const prototype = target.prototype;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (!/^(seed|fix)/.test(name)) continue;
      const step = prototype[name];
      if (typeof step !== 'function') continue;
      prototype[name] = async function (...args: unknown[]) {
        try {
          return await step.apply(this, args);
        } catch (error) {
          console.error(`Start-up step ${name} failed, the API starts anyway: ${(error as Error)?.message ?? error}`);
          return undefined;
        }
      };
    }
  };
}

@Injectable()
@NonFatalSteps()
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

  /**
   * Every pipeline has one stage of each system kind (deal_stage/stage-kind.ts): a missing one is
   * created with its default name. The kind decides, not the name: a renamed system stage is not
   * created again.
   *
   * Fallback for one release (DEAL_STAGE_* of .env): a stage of kind `work` that bears the
   * default name of a missing kind gets that kind instead of a new stage being made (a pipeline made
   * by the old code between the migration and this release).
   */
  async seedStages(): Promise<void> {
    const collections = await this.collectionRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.deal_stages', 't1')
      .getMany();

    const stagesToSave: DealStage[] = [];

    for (const collection of collections) {
      const stages = [...collection.deal_stages].sort((a, b) => a.id - b.id);
      for (const kind of SYSTEM_STAGE_KINDS) {
        if (stages.some((stage) => stage.kind === kind)) {
          continue;
        }

        const legacy = stages.find(
          (stage) => stage.kind === StageKind.WORK && legacyKindOfName(stage.name) === kind,
        );
        if (legacy) {
          legacy.kind = kind;
          stagesToSave.push(legacy);
          continue;
        }

        const newStage = new DealStage();
        newStage.name = defaultStageName(kind);
        newStage.kind = kind;
        newStage.collection = collection;
        stagesToSave.push(newStage);
      }
    }

    if (stagesToSave.length > 0) {
      console.log(`System deal stages: ${stagesToSave.length} created or given their kind`);
      await this.dealStageRepository.save(stagesToSave);
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

    // one stage of each system kind per pipeline (IDX_deal_stage_collection_kind): a stray stage of
    // a kind the pipeline already has becomes an ordinary one
    const taken = new Set(
      (
        await this.dealStageRepository
          .createQueryBuilder('t0')
          .where('t0.collection_id = :id', { id: defaultCollection?.id ?? 0 })
          .getMany()
      ).map((stage) => stage.kind),
    );
    for (const dealStage of dealStagesWithoutCollection) {
      dealStage.collection = defaultCollection;
      if (dealStage.kind !== StageKind.WORK) {
        if (taken.has(dealStage.kind)) dealStage.kind = StageKind.WORK;
        else taken.add(dealStage.kind);
      }
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

    // If no active collections, set default collection as active (none by that name: the oldest pipeline)
    if (activeCollections && activeCollections.length === 0) {
      const fallback =
        defaultCollection ?? (await this.collectionRepository.find({ order: { id: 'ASC' }, take: 1 }))[0];
      if (fallback) {
        fallback.is_active = true;

        await this.collectionRepository.save(fallback);
        console.log(`Collection ${fallback.id} is set as active!`);
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

  /**
   * The pipeline of an empty CRM only. Looked up by DEFAULT_COLLECTION_NAME alone, a changed name in .env made a
   * new empty pipeline at the next start, and fixCollectionStatuses() then made it the active one instead of the
   * pipeline with the deals.
   */
  async seedDefaultCollection(): Promise<void> {
    const defaultCollection = await this.collectionRepository.findOneBy({
      name: process.env.DEFAULT_COLLECTION_NAME,
    });

    if (defaultCollection) {
      console.log('Default Collection already exists!');
      return;
    }

    if ((await this.collectionRepository.count()) > 0) {
      console.warn(
        `No pipeline is named "${process.env.DEFAULT_COLLECTION_NAME}" (DEFAULT_COLLECTION_NAME), but pipelines exist: none created`,
      );
      return;
    }

    const newCollection = new DealStageCollection();
    newCollection.name = process.env.DEFAULT_COLLECTION_NAME;
    newCollection.is_active = true;

    await this.collectionRepository.save(newCollection);
    console.log('Populated default collection');
  }

  /**
   * The task types of an empty CRM only. They were looked up by name at every start, so a type the admin
   * renamed or deleted in the settings came back. The tasks the CRM makes itself find their type by
   * DEFAULT_TASK_TYPE with a fallback (task_type/default-task-type.ts), not by these names.
   */
  async seedTaskTypes(): Promise<void> {
    if ((await this.taskTypeRepository.count()) > 0) {
      console.log('Task types already exist');
      return;
    }
    await this.taskTypeRepository.save(
      ['Встреча', 'Связаться'].map((name) => this.taskTypeRepository.create({ name })),
    );
    console.log('Default task types created');
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
      // «Первичный контакт» of the active pipeline (any pipeline when none is active yet)
      newSettings.default_stage =
        (await this.stageRepository
          .createQueryBuilder('s')
          .innerJoin('s.collection', 'c')
          .where('s.kind = :kind', { kind: StageKind.FIRST_CONTACT })
          .orderBy('c.is_active', 'DESC')
          .addOrderBy('s.id', 'ASC')
          .getOne()) ?? null;

      await this.settingsRepository.save(newSettings);
      console.log('Default settings created');
    }

    console.log('Default settings are exist!');
  }
}
