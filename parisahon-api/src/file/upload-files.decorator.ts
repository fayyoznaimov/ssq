import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { catchError, Observable } from 'rxjs';
import { FileService } from './file.service';

/**
 * multer writes the files before the body is validated and before the handler
 * looks for the deal: a 400 / 404 left them on disk with no row. This removes
 * the files of a failed request that no row refers to.
 */
@Injectable()
export class DiscardFailedUploadsInterceptor implements NestInterceptor {
  constructor(private fileService: FileService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    return next.handle().pipe(
      catchError(async (error) => {
        await this.fileService.discardUploads(request.files);
        throw error;
      }),
    );
  }
}

/** multipart field "files": up to FileService.MAX_FILES files written to the uploads folder */
export const UploadFiles = () =>
  applyDecorators(
    UseInterceptors(
      FilesInterceptor(
        'files',
        FileService.MAX_FILES,
        FileService.getUploadOptions(),
      ),
      DiscardFailedUploadsInterceptor,
    ),
  );
