import * as fs from 'fs/promises';
import { Attachment } from 'nodemailer/lib/mailer';
import { join } from 'path';
import { Deal } from '../deal/deal.entity';
import { File } from '../file/file.entity';
import { FileService } from '../file/file.service';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { User } from '../user/user.entity';
import { safeFileName } from './mail-text';

/** Attachments of emails are kept as files in public/uploads (served at /uploads). */
const UPLOADS = join(__dirname, '..', '..', 'public', 'uploads');

/** An attachment of a received letter before it is written: the File row and its content. */
export interface PendingAttachment {
  file: File;
  content: Buffer;
}

/** The File of an attachment of a received email; nothing is written yet (writeAttachments). */
export function receivedAttachment(
  content: Buffer,
  filename: string,
  size: number,
  sender?: User,
): PendingAttachment {
  const name = safeFileName(filename);
  const file = new File();

  file.uploaded_by = sender;
  file.path = FileService.generateFileNameFromOriginalFileName(name);
  file.name = name;
  file.size = size ?? content?.length ?? 0;
  file.extension = File.extensionOf(name);
  file.from = WhichFiles.FROM_EMAILS;

  return { file, content };
}

/**
 * Writes the attachments of a received letter to disk right before its row is saved; when
 * writing one fails, the ones already written are removed again.
 */
export async function writeAttachments(pending: PendingAttachment[]): Promise<File[]> {
  const written: File[] = [];
  try {
    for (const attachment of pending) {
      await fs.writeFile(join(UPLOADS, attachment.file.path), attachment.content);
      written.push(attachment.file);
    }
  } catch (error) {
    await removeWritten(written);
    throw error;
  }
  return written;
}

/** The files of a letter whose row could not be saved: no orphans in public/uploads. */
export async function removeWritten(files: File[]): Promise<void> {
  for (const file of files) {
    await fs.unlink(join(UPLOADS, file.path)).catch(() => undefined);
  }
}

/**
 * Writes the files of an email sent from the CRM to disk; the Files are not saved. Called after the
 * mail server took the letter, so a letter that was not sent leaves no files behind.
 */
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
    file.name = safeFileName(upload.originalname);
    file.path = name;
    file.size = upload.size || upload.buffer?.length || 0;
    file.extension = File.extensionOf(file.name);
    file.from = WhichFiles.FROM_EMAILS;
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
