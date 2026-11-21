import {
  Body,
  Controller,
  Delete,
  Get, Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ProductService } from './product.service';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import { Product } from './product.entity';
import { CreateProductDto } from './dto/create.product.dto';
import { Request } from 'express';
import { UpdateProductDto } from './dto/update.product.dto';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { instanceToPlain } from 'class-transformer';
import { SearchProductDto } from './dto/search.product.dto';

@UseGuards(AuthGuard)
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  async fetchProducts(
    @Query() query: SearchProductDto,
  ): Promise<PaginationResponseDto<Product[]>> {
    return this.productService.fetchAll(query);
  }

  @Get('statistics')
  async fetchProductStats(
    @Query() query: PaginationRequestDto,
  ): Promise<PaginationResponseDto<any>> {
    return this.productService.getProductStats(query);
  }

  @Get(':id')
  async fetchById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.productService.fetchById(id));
  }

  @Post()
  async createProduct(
    @Body() body: CreateProductDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.productService.create(body, request));
  }

  @Patch(':id')
  async updateProduct(
    @Body() body: UpdateProductDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.productService.update(id, body, request);
  }

  @Delete(':id')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async deleteProduct(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.productService.deleteProduct(id);
  }

  @Delete('fillers/:id')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async deleteProductFiller(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.productService.deleteProductFiller(id);
  }
}
