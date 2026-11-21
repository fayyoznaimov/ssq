import { BaseExceptionFilter } from '@nestjs/core';
import { ArgumentsHost, Catch, Inject, Injectable } from '@nestjs/common';
import { LoggerService } from './logger.service';

@Injectable()
@Catch()
export class LoggingExceptionFilter extends BaseExceptionFilter {
  constructor(@Inject(LoggerService) private readonly logger: LoggerService) {
    super();
  }

  catch(exception: any, host: ArgumentsHost) {
    const status = exception.getStatus ? exception.getStatus() : 500;

    this.logger.error(
      `HTTP error: ${status} - ${exception.message}`,
      exception.stack,
    );

    super.catch(exception, host);
  }
}
