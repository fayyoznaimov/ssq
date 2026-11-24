import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ChildFiller, Filler, FillableTablesEnum } from './filler.entity';
import { In, Repository } from 'typeorm';
import { UpdateFillerDto } from './dto/update.filler.dto';
import { CompanyFiller } from '../company/company.filler.entity';
import { UserFiller } from '../user/user.filler.entity';
import { DealFiller } from '../deal/deal.filler.entity';
import { ProductFiller } from '../product/product.filler.entity';
import { AuditJournal } from '../audit/audit-journal';

/** the tables of the values of a custom field */
const VALUE_TABLES = ['company_filler', 'user_filler', 'deal_filler', 'product_filler'];

@Injectable()
export class FillerService {
  constructor(
    @InjectRepository(Filler)
    private fillerRepository: Repository<Filler>,
  ) {}

  async getByIds(ids: number[]): Promise<Filler[]> {
    return this.fillerRepository.findBy({ id: In(ids) });
  }

  async fetchAll(): Promise<Record<string, any[]>> {
    const fillers = await this.fillerRepository.find();

    return this.groupByTarget(fillers);
  }

  /**
   * ChildFiller -> UserFiller/DealFiller/CompanyFiller/ProductFiller
   *
   * Takes in ChildFillers and returns map of parent fillers
   */
  async getFillersHashMap(
    childFillers: ChildFiller[],
    // whose fields these must be: a contact's field cannot be attached to a company
    target?: FillableTablesEnum,
  ): Promise<Map<number, Filler>> {
    const requestedFillerIds = [
      ...new Set(childFillers.map((childFiller) => childFiller.filler_id)),
    ];
    const existingFillers = await this.getByIds(requestedFillerIds);

    if (requestedFillerIds.length !== existingFillers.length) {
      this.throwExceptionWithNonExistingFillers(
        requestedFillerIds,
        existingFillers,
      );
    }

    const foreign = target ? existingFillers.filter((filler) => filler.target !== target) : [];
    if (foreign.length) {
      throw new BadRequestException(
        `Доп. поля ${foreign.map((f) => f.id).join(', ')} относятся к другой сущности`,
      );
    }

    const fillersHashMap = new Map<number, Filler>();
    existingFillers.forEach((filler) => {
      fillersHashMap.set(filler.id, filler);
    });

    return fillersHashMap;
  }

  // TODO: Sometimes existing fillers type is coming as undefined, figure out why and fix
  // TODO: Refactor the types
  throwExceptionWithNonExistingFillers(
    requestedFillerIds: number[],
    existingFillers:
      | Filler[]
      | CompanyFiller[]
      | UserFiller[]
      | DealFiller[]
      | ProductFiller[],
  ): void {
    const existingFillerIds = [
      ...new Set(
        existingFillers.map(
          (
            existingFiller:
              | Filler
              | CompanyFiller
              | UserFiller
              | DealFiller
              | ProductFiller,
          ) => {
            return existingFiller.id;
          },
        ),
      ),
    ];

    // Find IDs that are in requestedFillerIds but not in existingFillerIds
    const nonExistingIds = requestedFillerIds.filter(
      (id) => !existingFillerIds.includes(id),
    );

    // TODO: Refactor!
    let target = 'Fillers';
    if (existingFillers[0] instanceof CompanyFiller) {
      target = 'Company Fillers';
    }
    if (existingFillers[0] instanceof UserFiller) {
      target = 'User Fillers';
    }
    if (existingFillers[0] instanceof DealFiller) {
      target = 'Deal Fillers';
    }
    if (existingFillers[0] instanceof ProductFiller) {
      target = 'Product Fillers';
    }

    throw new NotFoundException(
      `${target} with ids: ${nonExistingIds.join(', ')} does not exist!`,
    );
  }

  /**
   * "Обязательное" custom fields of a target must come with a value when the
   * entity is created. `items` are the custom fields sent with the entity.
   */
  async assertRequiredFilled(
    target: string,
    items: ChildFiller[] = [],
  ): Promise<void> {
    const missing = await this.missingRequired(target, items);

    if (missing.length) {
      throw new BadRequestException(
        missing.map((filler) => `Field "${filler.field}" is required`),
      );
    }
  }

  /** The required custom fields of a target that `items` leave empty. */
  async missingRequired(
    target: string,
    items: ChildFiller[] = [],
  ): Promise<Filler[]> {
    const required = await this.fillerRepository.findBy({
      target,
      is_required: true,
    });

    return required.filter(
      (filler) =>
        !items.some(
          (item) => item.filler_id === filler.id && item.value?.trim(),
        ),
    );
  }

  /** On update: a required custom field cannot be blanked. */
  assertNotBlank(filler: Filler, value: string | null | undefined): void {
    if (filler?.is_required && !value?.trim()) {
      throw new BadRequestException([`Field "${filler.field}" is required`]);
    }
  }

  async create(data: UpdateFillerDto): Promise<Filler> {
    if (
      await this.fillerRepository.findOneBy({
        field: data.field,
        target: data.target,
      })
    ) {
      throw new BadRequestException(
        `Target ${data.target} already has field ${data.field}`,
      );
    }

    const newFiller = new Filler();
    newFiller.target = data.target;
    newFiller.field = data.field;
    newFiller.is_required = data.is_required ?? false;

    return this.fillerRepository.save(newFiller);
  }

  async update(id: number, data: UpdateFillerDto): Promise<void> {
    const result = await this.fillerRepository.update(id, data);

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return;
  }

  /**
   * GET /fillers/:id/usage: how many companies, contacts, deals and products have a value of the field.
   * Deleting a field deletes all of its values (FillerService.delete): the web asks for this number first.
   */
  async usage(id: number): Promise<{ id: number; field: string; target: string; values: number }> {
    const filler = await this.fillerRepository.findOneBy({ id });
    if (!filler) {
      throw new NotFoundException();
    }
    const rows: { total: string }[] = await this.fillerRepository.query(
      `SELECT (SELECT count(*) FROM company_filler WHERE filler_id = $1)
            + (SELECT count(*) FROM user_filler WHERE filler_id = $1)
            + (SELECT count(*) FROM deal_filler WHERE filler_id = $1)
            + (SELECT count(*) FROM product_filler WHERE filler_id = $1) AS total`,
      [id],
    );
    return { id: filler.id, field: filler.field, target: filler.target, values: Number(rows[0]?.total ?? 0) };
  }

  /**
   * DELETE /fillers/:id: the field and its values in every company, contact, deal and product, in one
   * transaction, each value in the journal. The web said how many values go (GET /fillers/:id/usage).
   * The values are deleted here on purpose: the database refuses to delete a field that still has values
   * (ON DELETE RESTRICT, migration 1795721000000-delete-rules), so no other way loses them silently.
   */
  async delete(id: number): Promise<void> {
    await this.fillerRepository.manager.transaction(async (manager) => {
      // a value saved meanwhile waits for this lock, then finds the field gone
      const [filler] = await manager.query('SELECT id FROM filler WHERE id = $1 FOR UPDATE', [id]);
      if (!filler) {
        throw new NotFoundException();
      }
      for (const table of VALUE_TABLES) {
        await AuditJournal.around(manager, table, 't.filler_id = $1', [id], () =>
          manager.query(`DELETE FROM "${table}" WHERE filler_id = $1`, [id]),
        );
      }
      await manager.delete(Filler, id);
    });
  }

  // Every target is always present (an empty list when it has no fields):
  // the web app reads fillers.deal etc. directly and crashed on a missing key.
  private groupByTarget(data: Filler[]): Record<string, any[]> {
    const grouped: Record<string, any[]> = { company: [], user: [], deal: [], product: [] };
    for (const filler of data) (grouped[filler.target] ??= []).push(filler);
    return grouped;
  }
}
