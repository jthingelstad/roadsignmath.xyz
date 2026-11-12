// Which front a request came through. Each CloudFront distribution sets X-RSM-Front on its origin
// requests (infra/template.yaml) and overwrites one a viewer sends, and only CloudFront reaches
// the function, so the header can be trusted. Quiz's distribution says `quiz`; anything else,
// including no header (tests, `npm run dev` on its first port), is the site.

import type { Context } from 'hono';

export type Front = 'site' | 'quiz';

export const FRONT_HEADER = 'x-rsm-front';

export const frontOf = (c: Context): Front => (c.req.header(FRONT_HEADER) === 'quiz' ? 'quiz' : 'site');
