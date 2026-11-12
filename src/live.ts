// The live server's parts, from the environment the stack gives the web function
// (infra/template.yaml): the table, the photo bucket and the distribution that serves it, the
// sign-in address, where feedback goes, the site, the runtime secret and the team that signs
// the iPhone app.
// `src/server.ts` runs them; tests build them from a made-up environment without touching the
// network.

import type { ApiOptions } from './api/app.ts';
import { cloudFrontIp } from './api/app.ts';
import { CloudFrontEdgeCache } from './edge-cache.ts';
import { SesMailer } from './mail/mailer.ts';
import { KeyedModerator } from './moderation/moderator.ts';
import { S3PhotoStore } from './photos.ts';
import { TEAM_ID } from './web/apple.ts';
import { secretField } from './secrets.ts';
import { Buttondown } from './newsletter.ts';
import { KeyedTinylytics } from './tinylytics.ts';
import { DynamoStore } from './store/dynamo.ts';
import { quizOrigin } from './quiz/quiz.tsx';

export type LiveConfig = {
  table: string;
  photoBucket: string;
  /**
   * The stack's distribution, for clearing a hidden photo and changed pages from its caches; none
   * on the first deploy. (Named for the photos, its first use.)
   */
  photoDistributionId?: string;
  fromAddress: string;
  /** Where players' feedback is emailed. */
  feedbackTo: string;
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
  const feedbackTo = need('FEEDBACK_TO');
  if (!/^[^@\s<>]+@[^@\s<>]+\.[a-z]+$/i.test(feedbackTo)) throw new Error('FEEDBACK_TO must be an email address');
  const appleTeamId = env.APPLE_TEAM_ID?.trim() || undefined;
  if (appleTeamId && !TEAM_ID.test(appleTeamId)) throw new Error('APPLE_TEAM_ID must be a ten-character Team ID');
  return {
    table: need('TABLE'),
    photoBucket: need('PHOTO_BUCKET'),
    photoDistributionId: env.PHOTO_DISTRIBUTION_ID?.trim() || undefined,
    fromAddress: need('FROM_ADDRESS'),
    feedbackTo,
    site,
    runtimeSecret: need('RUNTIME_SECRET'),
    ...(appleTeamId ? { appleTeamId } : {})
  };
}

/** The key the moderator asks for: ANTHROPIC_API_KEY in the runtime secret. */
export const moderatorKey = (config: LiveConfig) => () => secretField(config.runtimeSecret, 'ANTHROPIC_API_KEY');

/** The key hearts and app views use: TINYLYTICS_API_KEY in the runtime secret. */
export const tinylyticsKey = (config: LiveConfig) => () => secretField(config.runtimeSecret, 'TINYLYTICS_API_KEY');

/** The newsletter's key: BUTTONDOWN_API_KEY in the runtime secret. */
export const buttondownKey = (config: LiveConfig) => () => secretField(config.runtimeSecret, 'BUTTONDOWN_API_KEY');

export function liveOptions(config: LiveConfig): ApiOptions {
  return {
    store: new DynamoStore(config.table),
    urls: { site: config.site, quiz: quizOrigin(config.site) },
    mailer: new SesMailer(config.fromAddress),
    feedbackTo: config.feedbackTo,
    photos: new S3PhotoStore(config.photoBucket, config.photoDistributionId),
    moderator: new KeyedModerator(moderatorKey(config)),
    clientIp: cloudFrontIp,
    appleTeamId: config.appleTeamId,
    tinylytics: new KeyedTinylytics(tinylyticsKey(config)),
    newsletter: new Buttondown(buttondownKey(config)),
    edgeCache: config.photoDistributionId ? new CloudFrontEdgeCache(config.photoDistributionId) : undefined
  };
}
