// The live server: the API on the Lambda Web Function behind CloudFront. tools/build-server.ts
// bundles this file into the code zip; `npm run dev` is the local server.

import { createApp } from './api/app.ts';
import { listen } from './listen.ts';
import { liveConfig, liveOptions } from './live.ts';

listen(createApp(liveOptions(liveConfig())));
