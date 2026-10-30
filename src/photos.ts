// The two sizes every photo is served at, as JPEGs with no metadata (so no GPS or camera
// details leave with them), and where they are kept. Served from /p/<photoId>/large.jpg and
// /p/<photoId>/thumb.jpg. An upload waits under uploads/<photoId>/ until its sign is posted;
// the live bucket's lifecycle rule clears uploads nobody posted.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import sharp from 'sharp';

export const PHOTO_SIZES = { large: 1600, thumb: 480 } as const;
export type PhotoSize = keyof typeof PHOTO_SIZES;
const SIZES = Object.keys(PHOTO_SIZES) as PhotoSize[];

export type Renditions = { large: Buffer; thumb: Buffer; width: number; height: number };

export async function renditions(input: Buffer): Promise<Renditions> {
  // rotate() applies the EXIF orientation before the metadata is dropped.
  const large = await sharp(input, { limitInputPixels: 60_000_000 })
    .rotate()
    .resize({ width: PHOTO_SIZES.large, height: PHOTO_SIZES.large, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(large.data)
    .resize({ width: PHOTO_SIZES.thumb, withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  return { large: large.data, thumb, width: large.info.width, height: large.info.height };
}

export interface PhotoStore {
  /** Keeps an upload's two sizes until its sign is posted. */
  putUpload(id: string, photo: Renditions): Promise<void>;
  /** One size of an upload, or of a posted photo when `posted`. */
  get(id: string, size: PhotoSize, posted: boolean): Promise<Buffer | undefined>;
  /** Moves an upload to where the site serves it. */
  publish(id: string): Promise<void>;
  /** Removes a posted photo. */
  remove(id: string): Promise<void>;
}

/** Tests: everything in a map. */
export class MemoryPhotoStore implements PhotoStore {
  readonly files = new Map<string, Buffer>();

  async putUpload(id: string, photo: Renditions): Promise<void> {
    for (const size of SIZES) this.files.set(`uploads/${id}/${size}`, photo[size]);
  }

  async get(id: string, size: PhotoSize, posted: boolean): Promise<Buffer | undefined> {
    return this.files.get(`${posted ? 'p' : 'uploads'}/${id}/${size}`);
  }

  async publish(id: string): Promise<void> {
    for (const size of SIZES) {
      const file = this.files.get(`uploads/${id}/${size}`);
      if (file) this.files.set(`p/${id}/${size}`, file);
      this.files.delete(`uploads/${id}/${size}`);
    }
  }

  async remove(id: string): Promise<void> {
    for (const size of SIZES) this.files.delete(`p/${id}/${size}`);
  }
}

/** `npm run dev`: posted photos in .data/photos/<id>/, uploads in .data/uploads/<id>/. */
export class DirPhotoStore implements PhotoStore {
  constructor(private readonly root = '.data') {}

  private dir(id: string, posted: boolean): string {
    return join(this.root, posted ? 'photos' : 'uploads', id);
  }

  async putUpload(id: string, photo: Renditions): Promise<void> {
    const dir = this.dir(id, false);
    await mkdir(dir, { recursive: true });
    for (const size of SIZES) await writeFile(join(dir, `${size}.jpg`), photo[size]);
  }

  async get(id: string, size: PhotoSize, posted: boolean): Promise<Buffer | undefined> {
    return readFile(join(this.dir(id, posted), `${size}.jpg`)).catch(() => undefined);
  }

  async publish(id: string): Promise<void> {
    await mkdir(join(this.root, 'photos'), { recursive: true });
    await rm(this.dir(id, true), { recursive: true, force: true });
    await rename(this.dir(id, false), this.dir(id, true));
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id, true), { recursive: true, force: true });
  }
}

/** The live bucket: posted photos under p/, which CloudFront serves, and uploads under uploads/. */
export class S3PhotoStore implements PhotoStore {
  private readonly client = new S3Client({});

  constructor(private readonly bucket: string) {}

  private key(id: string, size: PhotoSize, posted: boolean): string {
    return `${posted ? 'p' : 'uploads'}/${id}/${size}.jpg`;
  }

  async putUpload(id: string, photo: Renditions): Promise<void> {
    for (const size of SIZES) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id, size, false),
          Body: photo[size],
          ContentType: 'image/jpeg'
        })
      );
    }
  }

  async get(id: string, size: PhotoSize, posted: boolean): Promise<Buffer | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id, size, posted) })
      );
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : undefined;
    } catch (err) {
      if ((err as Error).name === 'NoSuchKey') return undefined;
      throw err;
    }
  }

  async publish(id: string): Promise<void> {
    for (const size of SIZES) {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${this.key(id, size, false)}`,
          Key: this.key(id, size, true),
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
          MetadataDirective: 'REPLACE'
        })
      );
    }
    await this.delete(SIZES.map((size) => this.key(id, size, false)));
  }

  async remove(id: string): Promise<void> {
    await this.delete(SIZES.map((size) => this.key(id, size, true)));
  }

  private async delete(keys: string[]): Promise<void> {
    await this.client.send(
      new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })
    );
  }
}
