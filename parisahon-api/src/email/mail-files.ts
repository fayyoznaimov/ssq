import * as fs from 'fs/promises';
import { Attachment } from 'nodemailer/lib/mailer';
import { extname, join } from 'path';
import { Deal } from '../deal/deal.entity';
import { File } from '../file/file.entity';
import { FileService } from '../file/file.service';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { User } from '../user/user.entity';

/** Attachments of emails are kept as files in public/uploads (served at /uploads). */
const UPLOADS = join(__dirname, '..', '..', 'public', 'uploads');

/** Writes an attachment of a received email to disk; the File is not saved. */
export async function saveReceivedAttachment(
  buffer: Buffer,
  filename: string,
  size: number,
  sender?: User,
): Promise<File> {
  const name = FileService.generateFileNameFromOriginalFileName(filename);
  await fs.writeFile(join(UPLOADS, name), buffer, 'binary');

  const file = new File();

  file.uploaded_by = sender;
  file.path = name;
  file.name = filename;
  file.size = size;
  file.extension = extname(filename);
  file.from = WhichFiles.FROM_EMAILS;

  return file;
}

/** Writes the files of an email sent from the CRM to disk; the Files are not saved. */
export async function saveSentFiles(
  files: Array<Express.Multer.File>,
  uploadedBy: User,
  deals: Deal[],
): Promise<File[]> {
  const saved: File[] = [];

  for (const upload of files) {
    const name = FileService.generateFileName(upload);
    await fs.writeFile(join(UPLOADS, name), upload.buffer);

    const file = new File();

    file.uploaded_by = uploadedBy;
    file.name = upload.originalname;
    file.path = name;
    file.deals = deals;

    saved.push(file);
  }

  return saved;
}

/** The same files as attachments of the outgoing message. */
export function toAttachments(files: Array<Express.Multer.File>): Attachment[] {
  return files.map((file) => ({
    filename: file.originalname,
    content: file.buffer,
    contentDisposition: 'attachment' as const,
  }));
}
