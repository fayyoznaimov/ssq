import { Injectable, NotFoundException } from '@nestjs/common';
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
      // Search by a part of the name, as companies and contacts do
      qb = qb.where('t0.name ILIKE :name', { name: `%${query.name}%` });
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

  async getProductStats(
    query: PaginationRequestDto,
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
    const sql = this.productRepository
      .createQueryBuilder('t0')
      .select('t0.id', 'id')
      .addSelect('t0.name', 'name')
      .addSelect('COUNT(t1.deal_id)', 'deal_count')
      .addSelect(
        'AVG(t1.price / NULLIF(t1.quantity, 0))',
        'average_price_per_product',
      )
      .addSelect('AVG(t1.price)', 'average_price_per_deal')
      .addSelect('AVG(t1.quantity)', 'average_quantity_per_deal')
      .addSelect('SUM(t1.price)', 'total_price_sold')
      .leftJoin('t0.deal_products', 't1')
      .where('t1.deal_id is not null')
      .groupBy('t0.id')
      .orderBy(`"${sortBy}"`, sortByType)
      .addOrderBy('t0.id', 'ASC')
      .offset(skip)
      .limit(limit)
      .getSql();

    const mainQuery = `
    WITH statistics as (${sql})
    SELECT *, COUNT(*) OVER() as total_count from statistics
    `;

    const data = await this.dataSource.query(mainQuery);

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
    response.last_page = Math.floor(response.count / limit + 1);

    return response;
  }

  async create(data: CreateProductDto, request: Request): Promise<Product> {
    const newProduct = new Product();

    newProduct.name = data.name;
    newProduct.created_by =
      await this.helperService.extractUserFromRequest(request);

    await this.fillerService.assertRequiredFilled(
      FillableTablesEnum.PRODUCT,
      data.fillers,
    );

    if (data.fillers.length > 0) {
      const fillers = await this.fillerService.getFillersHashMap(data.fillers);
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

    product.updated_by = originated_by;

    const productFillerIds = data.fillers.map(
      (filler) => filler.product_filler_id,
    );
    const productFillerIdsToValues = this.getProductFillersHashMap(
      data.fillers,
    );
    const productFillers = await this.getProductFillersByIds(productFillerIds);
    const fillerIdsToEntities = await this.fillerService.getFillersHashMap(
      data.fillers_create,
    );

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
    data.fillers_create.forEach((filler) => {
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
    await this.productRepository.save(product);

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
  ): Promise<ProductFiller[]> {
    const productFillers = await this.productFillerRepository.find({
      where: { id: In(ids) },
      relations: ['filler'],
    });

    if (ids.length !== productFillers.length) {
      this.fillerService.throwExceptionWithNonExistingFillers(
        ids,
        productFillers,
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
