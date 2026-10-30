// The two sizes every photo is served at, as JPEGs with no metadata (so no GPS or camera
// details leave with them). Served from /p/<photoId>/large.jpg and /p/<photoId>/thumb.jpg.

import sharp from 'sharp';

export const PHOTO_SIZES = { large: 1600, thumb: 480 } as const;

export type Renditions = { large: Buffer; thumb: Buffer; width: number; height: number };

export async function renditions(input: Buffer): Promise<Renditions> {
  // rotate() applies the EXIF orientation before the metadata is dropped.
  const large = await sharp(input)
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
