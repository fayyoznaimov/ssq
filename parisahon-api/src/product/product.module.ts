import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { ProductFiller } from './product.filler.entity';
import { HelperModule } from '../helper/helper.module';
import { FillerModule } from '../filler/filler.module';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductFiller]),
    HelperModule,
    FillerModule,
  ],
  controllers: [ProductController],
  providers: [ProductService],
})
export class ProductModule { }
