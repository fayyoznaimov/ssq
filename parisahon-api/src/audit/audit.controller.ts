import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { instanceToPlain } from 'class-transformer';
import { AuthGuard } from '../auth/auth.guard';
import { DealAccess, RecordAccess } from '../auth/access';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuditService } from './audit.service';
import { SearchAuditDto } from './dto/search.audit.dto';

/**
 * «История событий»: the business events and the changes of data together (AuditService).
 *  GET /audit              the journal page: everything, with filters (admin, manager)
 *  GET /audit/deal/:id     the history of a deal (who may see the deal)
 *  GET /audit/company/:id  of a company (who may see the company; deals out of the user's reach left out)
 *  GET /audit/user/:id     of a contact (the contact rules) or of an employee's account (themselves,
 *                          admin, manager); ?as=actor: what the employee did
 *  GET /audit/meta         the names of the kinds of objects, changes and sources (the filters)
 *  POST /audit/logout      the web client says the user left the CRM on this device
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles(AuthGuard.MANAGER_LEVEL)
  @Get()
  async journal(@Query() query: SearchAuditDto, @Req() request: Request): Promise<Record<string, any>> {
    return instanceToPlain(await this.audit.history({ kind: 'all' }, query, request['user']));
  }

  @Get('meta')
  meta(): ReturnType<AuditService['meta']> {
    return this.audit.meta();
  }

  @DealAccess('view')
  @Get('deal/:id')
  async deal(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchAuditDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.audit.history({ kind: 'deal', id }, AuditController.scoped(query), request['user']));
  }

  @RecordAccess('company', 'view')
  @Get('company/:id')
  async company(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchAuditDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.audit.history({ kind: 'company', id }, AuditController.scoped(query), request['user']));
  }

  @RecordAccess('staffData', 'view')
  @Get('user/:id')
  async user(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchAuditDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.audit.history({ kind: 'user', id }, AuditController.scoped(query), request['user']));
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@Req() request: Request): Promise<void> {
    await this.audit.loggedOut(request['user'], request);
  }

  /** A card is its own scope: the filters of the journal page for another deal / company do not apply. */
  private static scoped(query: SearchAuditDto): SearchAuditDto {
    query.deal_id = undefined;
    query.company_id = undefined;
    query.contact_id = undefined;
    return query;
  }
}
