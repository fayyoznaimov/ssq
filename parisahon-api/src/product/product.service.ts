import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { DataSource, In, Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import {
  CreateProductDto,
  CreateProductFillerDto,
} from './dto/create.product.dto';
import { Request } from 'express';
import { FillerService } from '../filler/filler.service';
import { FillableTablesEnum, Filler } from '../filler/filler.entity';
import { ProductFiller } from './product.filler.entity';
import {
  UpdateProductDto,
  UpdateProductFillerDto,
} from './dto/update.product.dto';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { EventTypes, FieldsOf } from '../events/event.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import { SearchProductDto } from './dto/search.product.dto';
import { ProductStatsQueryDto } from '../analytics/dto/product-stats.query.dto';
import { periodBounds } from '../analytics/period';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(ProductFiller)
    private productFillerRepository: Repository<ProductFiller>,
    private dataSource: DataSource,
    private helperService: HelperService,
    private fillerService: FillerService,
    private eventEmitter: EventEmitter2,
  ) {}

  async fetchAll(
    query: SearchProductDto,
  ): Promise<PaginationResponseDto<Product[]>> {
    let qb = this.productRepository.createQueryBuilder('t0');

    if (query.name) {
      // Search by a part of the name or of the article, as companies and contacts do
      qb = qb.andWhere('(t0.name ILIKE :name OR t0.sku ILIKE :name)', { name: `%${query.name}%` });
    }
    // «Дата создания» of the list (it was never sent): whole days
    if (query.created_from) {
      qb = qb.andWhere('t0.created_at >= CAST(:created_from AS date)', { created_from: query.created_from });
    }
    if (query.created_till) {
      qb = qb.andWhere("t0.created_at < CAST(:created_till AS date) + interval '1 day'", { created_till: query.created_till });
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, [
        'product_fillers',
        'product_fillers.filler',
      ]),
      query,
    );
  }

  async fetchById(id: number): Promise<Product> {
    return this.helperService.getById(Product, id, [
      'product_fillers',
      'product_fillers.filler',
      'created_by',
      'updated_by',
    ]);
  }

  /**
   * «По товарам»: the products of the deals (not deleted), a page of them with the total count. With
   * from_date / till_date: the deals created in that period. The page is cut (LIMIT / OFFSET) outside the
   * aggregate, after the total is counted: inside it the total was never more than one page (HACK-18).
   */
  async getProductStats(
    query: ProductStatsQueryDto,
  ): Promise<PaginationResponseDto<any>> {
    const [sortBy, sortByType] = this.helperService.validateAndGetSortOptions(
      query,
      [
        'deal_count',
        'average_price_per_product',
        'average_price_per_deal',
        'average_quantity_per_deal',
        'total_price_sold',
      ],
    );
    const skip = query.skip ?? 0;
    const limit = query.limit ?? 25;

    /**
     * TypeORM does not provide get raw many and count functionality.
     * Have to do a workaround
     */
    // The sort columns are aggregates, so the ORDER BY has to use their
    // aliases: `t0.deal_count` was a 500 for every sorted request.
    const qb = this.productRepository
      .createQueryBuilder('t0')
      .select('t0.id', 'id')
      .addSelect('t0.name', 'name')
      .addSelect('COUNT(DISTINCT t1.deal_id)', 'deal_count')
      // deal_product.price is the price of one unit (metre, kilo, piece) and quantity may be
      // fractional (numeric since 1795620000100): «за шт» is the unit price, «сделка» and the sum
      // are quantity × price (the old bigint division price / quantity cut the cents off)
      .addSelect('AVG(t1.price)', 'average_price_per_product')
      .addSelect('AVG(t1.price * t1.quantity)', 'average_price_per_deal')
      .addSelect('AVG(t1.quantity)', 'average_quantity_per_deal')
      .addSelect('SUM(t1.price * t1.quantity)', 'total_price_sold')
      .leftJoin('t0.deal_products', 't1')
      .where('t1.deal_id is not null')
      // deals in the trash are not sales
      .andWhere('EXISTS (SELECT 1 FROM deal pd WHERE pd.id = t1.deal_id AND pd.deleted_at IS NULL)')
      .groupBy('t0.id');
    if (query.from_date && query.till_date) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM deal pp WHERE pp.id = t1.deal_id AND pp.created_at >= :from_date AND pp.created_at <= :till_date)',
        periodBounds({ from_date: query.from_date, till_date: query.till_date }),
      );
    }
    const [sql, params] = qb.getQueryAndParameters();
    // sortBy is one of the names above (validateAndGetSortOptions), the direction ASC / DESC
    const direction = String(sortByType).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const mainQuery = `
    WITH statistics AS (${sql})
    SELECT *, COUNT(*) OVER() AS total_count FROM statistics
     ORDER BY "${sortBy}" ${direction} NULLS LAST, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const data = await this.dataSource.query(mainQuery, [...params, Number(limit), Number(skip)]);

    const response = new PaginationResponseDto();
    response.count = 0;

    const responseData = [];

    if (data.length > 0) {
      response.count = +data[0].total_count;
      data.forEach((row) => {
        responseData.push({
          id: row.id,
          name: row.name,
          deal_count: +row.deal_count,
          average_price_per_product: +row.average_price_per_product,
          average_price_per_deal: +row.average_price_per_deal,
          average_quantity_per_deal: +row.average_quantity_per_deal,
          total_price_sold: +row.total_price_sold,
        });
      });
    }

    response.data = responseData;
    response.page_size = Number(limit);
    response.current_page = Math.floor(skip / limit + 1);
    response.last_page = Math.max(1, Math.ceil(response.count / limit));

    return response;
  }

  async create(data: CreateProductDto, request: Request): Promise<Product> {
    const newProduct = new Product();

    newProduct.name = data.name;
    newProduct.sku = data.sku ?? null;
    newProduct.unit = data.unit ?? null;
    newProduct.price = data.price ?? null;
    newProduct.created_by =
      await this.helperService.extractUserFromRequest(request);
    data.fillers = data.fillers ?? [];

    await this.fillerService.assertRequiredFilled(
      FillableTablesEnum.PRODUCT,
      data.fillers,
    );

    if (data.fillers.length > 0) {
      const fillers = await this.fillerService.getFillersHashMap(data.fillers, FillableTablesEnum.PRODUCT);
      newProduct.product_fillers = this.createProductFillers(
        fillers,
        data.fillers,
      );
    }

    return this.productRepository.save(newProduct);
  }

  async update(
    id: number,
    data: UpdateProductDto,
    request: Request,
  ): Promise<void> {
    const product = await this.helperService.getById(Product, id, [
      'deal_products',
      'deal_products.deal',
    ]);
    const originated_by =
      await this.helperService.extractUserFromRequest(request);

    const updatedFields: Field[] = [];

    updatedFields.push(new Field('name', data.name, product.name));
    product.name = data.name;

    // the catalogue fields: only those sent change
    for (const key of ['sku', 'unit', 'price'] as const) {
      if (data[key] === undefined) continue;
      const value = data[key] ?? null;
      if (value === (product[key] ?? null)) continue;
      updatedFields.push(
        new Field(key, value === null ? null : String(value), product[key] === null || product[key] === undefined ? null : String(product[key])),
      );
      (product as any)[key] = value;
    }

    product.updated_by = originated_by;

    const fillersToUpdate = data.fillers ?? [];
    const fillersToCreate = data.fillers_create ?? [];
    const productFillerIds = fillersToUpdate.map(
      (filler) => filler.product_filler_id,
    );
    const productFillerIdsToValues = this.getProductFillersHashMap(
      fillersToUpdate,
    );
    // values of THIS product only: another product's value id was changed without a trace
    const productFillers = await this.getProductFillersByIds(productFillerIds, product.id);
    const fillerIdsToEntities = fillersToCreate.length
      ? await this.fillerService.getFillersHashMap(fillersToCreate, FillableTablesEnum.PRODUCT)
      : new Map<number, Filler>();

    // Update necessary product fillers
    productFillers.forEach((productFiller) => {
      const newFillerValue = productFillerIdsToValues.get(productFiller.id);

      if (newFillerValue != productFiller.value) {
        this.fillerService.assertNotBlank(productFiller.filler, newFillerValue);
        updatedFields.push(
          new Field(
            productFiller.filler.field,
            newFillerValue,
            productFiller.value,
          ),
        );
      }
      productFiller.value = newFillerValue;
    });

    // Create necessary product fillers
    fillersToCreate.forEach((filler) => {
      const newProductFiller = new ProductFiller();
      newProductFiller.value = filler.value;
      newProductFiller.filler = fillerIdsToEntities.get(filler.filler_id);
      newProductFiller.product = product;
      productFillers.push(newProductFiller);

      updatedFields.push(
        new Field(
          fillerIdsToEntities.get(filler.filler_id).field,
          filler.value,
        ),
      );
    });

    await this.productFillerRepository.save(productFillers);
    // update by id: the product holds its deal products (a cycle for save())
    await this.productRepository.update(product.id, {
      name: product.name,
      sku: product.sku,
      unit: product.unit,
      price: product.price,
      updated_by: { id: originated_by.id } as any,
    });

    // Emit necessary events
    product.deal_products.forEach((dealProduct) => {
      const deal = dealProduct.deal;
      const eventData: FieldValueEventDto = {
        originated_by: originated_by,
        deal: deal,
        fields: updatedFields,
        fields_of: FieldsOf.PRODUCT,
      };
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    });
  }

  async deleteProductFiller(id: number): Promise<void> {
    const result = await this.productFillerRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException(
        `Product filler with id ${id} does not exist!`,
      );
    }
  }

  async deleteProduct(id: number): Promise<void> {
    const result = await this.productRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Product with id ${id} does not exist!`);
    }
  }

  private async getProductFillersByIds(
    ids: number[],
    productId: number,
  ): Promise<ProductFiller[]> {
    const wanted = [...new Set(ids)];
    if (!wanted.length) return [];
    const productFillers = await this.productFillerRepository.find({
      where: { id: In(wanted), product: { id: productId } },
      relations: ['filler'],
    });

    if (wanted.length !== productFillers.length) {
      const found = new Set(productFillers.map((row) => row.id));
      throw new BadRequestException(
        `Значения доп. полей ${wanted.filter((id) => !found.has(id)).join(', ')} не относятся к этому товару`,
      );
    }

    return productFillers;
  }

  private getProductFillersHashMap(
    data: UpdateProductFillerDto[],
  ): Map<number, string> {
    const hashMap = new Map<number, string>();

    data.forEach((productFiller) => {
      hashMap.set(productFiller.product_filler_id, productFiller.value);
    });

    return hashMap;
  }

  private createProductFillers(
    fillers: Map<number, Filler>,
    data: CreateProductFillerDto[],
  ): ProductFiller[] {
    const newProductFillers: ProductFiller[] = [];

    data.forEach((productFiller) => {
      const newProductFiller = new ProductFiller();
      newProductFiller.value = productFiller.value;
      newProductFiller.filler = fillers.get(productFiller.filler_id);

      newProductFillers.push(newProductFiller);
    });

    return newProductFillers;
  }
}
