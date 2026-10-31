// The live server's parts, from the environment the stack gives the web function
// (infra/template.yaml): the table, the photo bucket and the distribution that serves it, the
// sign-in address, the site, the runtime secret and the team that signs the iPhone app.
// `src/server.ts` runs them; tests build them from a made-up environment without touching the
// network.

import type { ApiOptions } from './api/app.ts';
import { cloudFrontIp } from './api/app.ts';
import { SesMailer } from './mail/mailer.ts';
import { KeyedModerator } from './moderation/moderator.ts';
import { S3PhotoStore } from './photos.ts';
import { TEAM_ID } from './web/apple.ts';
import { secretField } from './secrets.ts';
import { KeyedTinylytics } from './tinylytics.ts';
import { DynamoStore } from './store/dynamo.ts';

export type LiveConfig = {
  table: string;
  photoBucket: string;
  /** The distribution serving /p/, for clearing a hidden photo from its caches; none on the first deploy. */
  photoDistributionId?: string;
  fromAddress: string;
  site: string;
  runtimeSecret: string;
  /** The team that signs the iPhone app, for apple-app-site-association; unset, none is served. */
  appleTeamId?: string;
};

export function liveConfig(env: Record<string, string | undefined> = process.env): LiveConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const site = need('SITE_URL');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) throw new Error('SITE_URL must be an https origin');
  const appleTeamId = env.APPLE_TEAM_ID?.trim() || undefined;
  if (appleTeamId && !TEAM_ID.test(appleTeamId)) throw new Error('APPLE_TEAM_ID must be a ten-character Team ID');
  return {
    table: need('TABLE'),
    photoBucket: need('PHOTO_BUCKET'),
    photoDistributionId: env.PHOTO_DISTRIBUTION_ID?.trim() || undefined,
    fromAddress: need('FROM_ADDRESS'),
    site,
    runtimeSecret: need('RUNTIME_SECRET'),
    ...(appleTeamId ? { appleTeamId } : {})
  };
}

/** The key the moderator asks for: ANTHROPIC_API_KEY in the runtime secret. */
export const moderatorKey = (config: LiveConfig) => () => secretField(config.runtimeSecret, 'ANTHROPIC_API_KEY');

/** The key hearts and app views use: TINYLYTICS_API_KEY in the runtime secret. */
export const tinylyticsKey = (config: LiveConfig) => () => secretField(config.runtimeSecret, 'TINYLYTICS_API_KEY');

export function liveOptions(config: LiveConfig): ApiOptions {
  return {
    store: new DynamoStore(config.table),
    urls: { site: config.site },
    mailer: new SesMailer(config.fromAddress),
    photos: new S3PhotoStore(config.photoBucket, config.photoDistributionId),
    moderator: new KeyedModerator(moderatorKey(config)),
    clientIp: cloudFrontIp,
    appleTeamId: config.appleTeamId,
    tinylytics: new KeyedTinylytics(tinylyticsKey(config))
  };
}
