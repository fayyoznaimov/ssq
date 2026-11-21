import { EventDto } from './event.dto';
import { DealProduct } from '../../deal/deal-product.entity';

export class ProductEventDto extends EventDto {
  deal_product: DealProduct;
}
