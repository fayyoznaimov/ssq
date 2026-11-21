import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { RecognitionResult, RecognitionService } from './recognition.service';

/**
 * POST /api/v1/companies/recognize  (multipart, field "file")
 * Reads a photo / PDF of a company card or a business card and returns the
 * recognized fields, format warnings and possible duplicates.
 * Nothing is saved: the client shows the result for review and then calls
 * the usual POST /companies or POST /users.
 * Authentication comes from the global guard (any staff role).
 */
@Controller('companies')
export class RecognitionController {
  constructor(private recognitionService: RecognitionService) {}

  @Post('recognize')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
      fileFilter: (req, file, callback) => {
        if (RecognitionService.acceptedMimeTypes.includes(file.mimetype)) {
          return callback(null, true);
        }
        callback(
          new BadRequestException('Поддерживаются JPEG, PNG, WebP, GIF и PDF'),
          false,
        );
      },
    }),
  )
  async recognize(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<RecognitionResult> {
    return this.recognitionService.recognizeCard(file);
  }

  /**
   * POST /api/v1/companies/recognize/check  (JSON, same shape as the result
   * of /recognize without warnings/duplicates). For clients that read the
   * image themselves: normalizes values, checks formats, finds duplicates.
   * Nothing is saved.
   */
  @Post('recognize/check')
  async check(@Body() body: Record<string, unknown>): Promise<RecognitionResult> {
    return this.recognitionService.checkCard(body);
  }
}
