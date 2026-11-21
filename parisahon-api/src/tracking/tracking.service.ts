import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { SearchTrackingDto } from './dto/search.tracking.dto';

@Injectable()
export class TrackingService {
  constructor(
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
    private helperService: HelperService,
  ) {}

  async fetchLogs(
    query: SearchTrackingDto,
  ): Promise<PaginationResponseDto<Event[]>> {
    let qb = this.eventRepository.createQueryBuilder('t0');

    if (query.originated_by) {
      qb = qb.where('t0.user_id = :user_id', { user_id: query.originated_by });
    }

    if (query.types) {
      qb = qb.andWhere('t0.type IN (:...types)', { types: query.types });
    }

    if (query.created_after) {
      qb = qb.andWhere('t0.created_at > :created_after', {
        created_after: query.created_after,
      });
    }

    if (query.created_before) {
      qb = qb.andWhere('t0.created_at < :created_before', {
        created_before: query.created_before,
      });
    }

    if (query.entities) {
      qb = qb.andWhere('t0.field_of IN (:...entities)', {
        entities: query.entities,
      });
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, [
        'deal',
        'originated_by',
        'target_user',
        'target_group',
        'task',
      ]),
      query,
    );
  }
}
