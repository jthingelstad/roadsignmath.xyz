// Road Sign Math Quiz at quiz.roadsignmath.xyz (docs: AGENTS.md, Quiz). It answers only through
// Quiz's distribution (src/front.ts); the site never serves these pages, and Quiz never serves
// the site's or the API.
//
// Until Jamie launches it, `QUIZ_OPEN` is false and every address answers the same short page
// saying Quiz is coming, kept out of search engines.

import { Hono } from 'hono';
import type { ApiOptions } from '../api/app.ts';

/** Whether Quiz is open. Jamie's call; until then every address answers the coming-soon page. */
export const QUIZ_OPEN = false;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

export function createQuiz(options: ApiOptions): Hono {
  const quiz = new Hono();
  quiz.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, NO_STORE));
  quiz.all('*', (c) => c.html(soon(options.urls.site), 200, NO_STORE));
  return quiz;
}

function soon(site: string): string {
  return (
    '<!doctype html>' +
    (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex, nofollow" />
          <title>Road Sign Math Quiz</title>
          <link rel="icon" href={`${site}/favicon.svg`} type="image/svg+xml" />
          <style>{`
            :root { color-scheme: light dark; --ink: #18201C; --paper: #F7F5EF; --green: #006348; }
            @media (prefers-color-scheme: dark) { :root { --ink: #F7F5EF; --paper: #18201C; --green: #5FC29C; } }
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
              box-sizing: border-box; background: var(--paper); color: var(--ink);
              font: 18px/1.5 system-ui, -apple-system, sans-serif; text-align: center; }
            h1 { font-size: 28px; margin: 0 0 8px; }
            a { color: var(--green); font-weight: 700; }
          `}</style>
        </head>
        <body>
          <main>
            <h1>Road Sign Math Quiz</h1>
            <p>Coming soon.</p>
            <p>
              <a href={site}>See the signs on roadsignmath.xyz</a>
            </p>
          </main>
        </body>
      </html>
    ).toString()
  );
}
