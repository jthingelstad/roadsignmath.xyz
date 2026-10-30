// The two sizes every photo is served at, as JPEGs with no metadata (so no GPS or camera
// details leave with them), and where they are kept. A shown sign's photos are served from
// /p/<photoId>/large.jpg and /p/<photoId>/thumb.jpg. An upload waits under uploads/<photoId>/
// until its sign is posted, and the live bucket's lifecycle rule clears uploads nobody posted.
// A held or hidden sign's photos sit under held/<photoId>/, which only the API reads, for
// their poster.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
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

/**
 * Where a photo is kept: `upload` until its sign is posted, `shown` (under p/, which the site
 * serves) while its sign is shown, and `held` (served to nobody but its poster, through the API)
 * while its sign is held or hidden.
 */
export type PhotoPlace = 'upload' | 'shown' | 'held';

export interface PhotoStore {
  /** Keeps an upload's two sizes until its sign is posted. */
  putUpload(id: string, photo: Renditions): Promise<void>;
  /** One size of a photo, from where it is kept. */
  get(id: string, size: PhotoSize, place: PhotoPlace): Promise<Buffer | undefined>;
  /** Moves an upload to `shown` or `held`, as its sign's moderation says. */
  publish(id: string, place: 'shown' | 'held'): Promise<void>;
  /** Puts a posted photo back with the uploads, when the post that published it fails. */
  unpublish(id: string): Promise<void>;
  /** Takes a shown photo down to `held`, when its sign is hidden. */
  hide(id: string): Promise<void>;
  /** Removes a posted photo, wherever it is. */
  remove(id: string): Promise<void>;
}

const PREFIX: Record<PhotoPlace, string> = { upload: 'uploads', shown: 'p', held: 'held' };

/** Tests: everything in a map, keyed like the bucket. */
export class MemoryPhotoStore implements PhotoStore {
  readonly files = new Map<string, Buffer>();

  /** Moves what is there; a photo already moved is left alone. */
  private move(id: string, from: PhotoPlace, to: PhotoPlace): void {
    for (const size of SIZES) {
      const file = this.files.get(`${PREFIX[from]}/${id}/${size}`);
      if (!file) continue;
      this.files.set(`${PREFIX[to]}/${id}/${size}`, file);
      this.files.delete(`${PREFIX[from]}/${id}/${size}`);
    }
  }

  async putUpload(id: string, photo: Renditions): Promise<void> {
    for (const size of SIZES) this.files.set(`uploads/${id}/${size}`, photo[size]);
  }

  async get(id: string, size: PhotoSize, place: PhotoPlace): Promise<Buffer | undefined> {
    return this.files.get(`${PREFIX[place]}/${id}/${size}`);
  }

  async publish(id: string, place: 'shown' | 'held'): Promise<void> {
    this.move(id, 'upload', place);
  }

  async unpublish(id: string): Promise<void> {
    this.move(id, 'shown', 'upload');
    this.move(id, 'held', 'upload');
  }

  async hide(id: string): Promise<void> {
    this.move(id, 'shown', 'held');
  }

  async remove(id: string): Promise<void> {
    for (const size of SIZES) {
      this.files.delete(`p/${id}/${size}`);
      this.files.delete(`held/${id}/${size}`);
    }
  }
}

/** `npm run dev`: .data/photos/<id>/ (shown), .data/held/<id>/ and .data/uploads/<id>/. */
export class DirPhotoStore implements PhotoStore {
  constructor(private readonly root = '.data') {}

  private dir(id: string, place: PhotoPlace): string {
    return join(this.root, place === 'shown' ? 'photos' : PREFIX[place], id);
  }

  /** Moves what is there; a photo already moved is left alone. */
  private async move(id: string, from: PhotoPlace, to: PhotoPlace): Promise<void> {
    if (!existsSync(this.dir(id, from))) return;
    await mkdir(join(this.dir(id, to), '..'), { recursive: true });
    await rm(this.dir(id, to), { recursive: true, force: true });
    await rename(this.dir(id, from), this.dir(id, to));
  }

  async putUpload(id: string, photo: Renditions): Promise<void> {
    const dir = this.dir(id, 'upload');
    await mkdir(dir, { recursive: true });
    for (const size of SIZES) await writeFile(join(dir, `${size}.jpg`), photo[size]);
  }

  async get(id: string, size: PhotoSize, place: PhotoPlace): Promise<Buffer | undefined> {
    return readFile(join(this.dir(id, place), `${size}.jpg`)).catch(() => undefined);
  }

  async publish(id: string, place: 'shown' | 'held'): Promise<void> {
    await this.move(id, 'upload', place);
  }

  async unpublish(id: string): Promise<void> {
    await this.move(id, 'shown', 'upload');
    await this.move(id, 'held', 'upload');
  }

  async hide(id: string): Promise<void> {
    await this.move(id, 'shown', 'held');
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id, 'shown'), { recursive: true, force: true });
    await rm(this.dir(id, 'held'), { recursive: true, force: true });
  }
}

/**
 * The live bucket: shown photos under p/, the only prefix CloudFront serves, and held photos
 * and uploads beside them. Shown photos are cached for good, so hiding one also clears it from
 * CloudFront's caches.
 */
export class S3PhotoStore implements PhotoStore {
  private readonly client = new S3Client({});
  private readonly cdn = new CloudFrontClient({});

  constructor(
    private readonly bucket: string,
    /** The distribution serving p/; none skips the cache clearing. */
    private readonly distributionId?: string
  ) {}

  private key(id: string, size: PhotoSize, place: PhotoPlace): string {
    return `${PREFIX[place]}/${id}/${size}.jpg`;
  }

  async putUpload(id: string, photo: Renditions): Promise<void> {
    for (const size of SIZES) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id, size, 'upload'),
          Body: photo[size],
          ContentType: 'image/jpeg'
        })
      );
    }
  }

  async get(id: string, size: PhotoSize, place: PhotoPlace): Promise<Buffer | undefined> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id, size, place) }));
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : undefined;
    } catch (err) {
      if ((err as Error).name === 'NoSuchKey') return undefined;
      throw err;
    }
  }

  /** Moves what is there; a photo already moved is left alone. */
  private async move(id: string, from: PhotoPlace, to: PhotoPlace): Promise<void> {
    const moved: string[] = [];
    for (const size of SIZES) {
      if (!(await this.exists(this.key(id, size, from)))) continue;
      moved.push(this.key(id, size, from));
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${this.key(id, size, from)}`,
          Key: this.key(id, size, to),
          ContentType: 'image/jpeg',
          CacheControl: to === 'shown' ? 'public, max-age=31536000, immutable' : 'private, no-store',
          MetadataDirective: 'REPLACE'
        })
      );
    }
    if (moved.length) await this.delete(moved);
  }

  async publish(id: string, place: 'shown' | 'held'): Promise<void> {
    await this.move(id, 'upload', place);
  }

  async unpublish(id: string): Promise<void> {
    await this.move(id, 'shown', 'upload');
    await this.move(id, 'held', 'upload');
    await this.clearCache(id);
  }

  async hide(id: string): Promise<void> {
    await this.move(id, 'shown', 'held');
    await this.clearCache(id);
  }

  async remove(id: string): Promise<void> {
    await this.delete(SIZES.flatMap((size) => [this.key(id, size, 'shown'), this.key(id, size, 'held')]));
    await this.clearCache(id);
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if ((err as Error).name === 'NotFound' || (err as Error).name === 'NoSuchKey') return false;
      throw err;
    }
  }

  private async clearCache(id: string): Promise<void> {
    if (!this.distributionId) return;
    await this.cdn.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: { CallerReference: `${id}-${Date.now()}`, Paths: { Quantity: 1, Items: [`/p/${id}/*`] } }
      })
    );
  }

  private async delete(keys: string[]): Promise<void> {
    await this.client.send(
      new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })
    );
  }
}
