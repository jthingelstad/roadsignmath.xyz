// /app: the iPhone app, as the design's App board draws it. Where "Get the app" goes: what the
// app does (three of its screens), how to join the TestFlight beta (the link, and a QR code for
// a reader on a computer), the questions people ask first, and how to play.

import type { Hono } from 'hono';
import type { Urls } from '../api/views.ts';
import { APP_SHOTS, BETA_QR_SVG } from './app-assets.ts';
import { Page, Phone, TESTFLIGHT_URL } from './layout.tsx';

const DAY = 'public, max-age=86400';

const APP_STYLE = `
.getapp h2 { margin: 0; font-size: clamp(28px, 4.5vw, 34px); line-height: 1.1; }
.getapp h3 { margin: 0; font-size: 18px; font-weight: 800; }
.getapp section > .wrap { padding-top: 48px; padding-bottom: 56px; }
.hero { background: var(--green); color: #fff; }
.hero .wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 32px; }
.hero .pitch { flex: 1 1 520px; display: flex; flex-direction: column; gap: 16px; }
.kicker { margin: 0; display: flex; align-items: center; gap: 10px; font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase; }
.beta { padding: 2px 9px 0; border-radius: 999px; background: var(--yellow); color: #18201C; font-weight: 900; font-size: 12px;
  letter-spacing: 0.06em; }
.hero h1 { margin: 0; font-size: clamp(38px, 6.5vw, 56px); line-height: 1.02; }
.hero .lead { margin: 0; font-size: 19px; max-width: 600px; color: #E3EFE9; }
.hero .join { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; }
.hero .join p { margin: 0; font-size: 15px; color: #E3EFE9; }
.qr { margin: 0; flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 196px; padding: 18px;
  background: #fff; border-radius: 16px; color: #18201C; font-size: 13px; line-height: 1.35; text-align: center; }
.qr span, .qr svg { display: block; width: 156px; height: 156px; }
/* On a phone the link is the way in; the code is for a reader on a computer. */
@media (max-width: 759px) { .qr { display: none; } }
.does { background: var(--ground); }
.does .wrap { display: flex; flex-direction: column; gap: 28px; }
.shots { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 32px 28px; }
.shots li { display: flex; flex-direction: column; gap: 6px; }
.phone { display: block; max-width: 300px; margin-bottom: 12px; padding: 8px; border-radius: 40px; background: #18201C;
  box-shadow: 0 10px 30px rgba(0,0,0,.14); }
/* On a phone each screen sits small beside its words, so the three don't fill three screens. */
@media (max-width: 599px) {
  .shots li { display: grid; grid-template-columns: 132px 1fr; gap: 6px 18px; align-content: center; }
  .shots .phone { grid-row: span 2; margin: 0; padding: 5px; border-radius: 22px; }
  .shots .phone img { border-radius: 18px; }
  .shots h3 { align-self: end; }
}
.phone img { display: block; width: 100%; height: auto; border-radius: 32px; background: var(--photo); }
.shots p { margin: 0; color: var(--ink2); }
.joining { border-top: 1px solid var(--line); }
.joining .wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 32px 56px; align-items: start; }
.joining .steps { margin: 20px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 18px; }
.joining .steps li { display: grid; grid-template-columns: 36px 1fr; gap: 2px 14px; }
.joining .n { grid-row: span 2; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 8px;
  background: var(--green); color: #fff; font-weight: 900; box-shadow: inset 0 0 0 2px var(--green), inset 0 0 0 4px #fff; }
.joining .steps p { margin: 0; color: var(--ink2); }
.faq { margin: 0; display: flex; flex-direction: column; gap: 12px; }
.faq div { padding: 16px 18px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.faq dt { font-weight: 800; }
.faq dd { margin: 4px 0 0; color: var(--ink2); }
.how { background: var(--ground); border-top: 1px solid var(--line); }
.how .wrap { display: flex; flex-direction: column; gap: 24px; }
.how ol { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 16px; }
.how li { display: flex; flex-direction: column; gap: 6px; padding: 18px 20px; background: var(--card); border: 1px solid var(--line);
  border-radius: 12px; }
.how p { margin: 0; color: var(--ink2); }
`;

/** The three screens, in the order the game goes: read the sign, make it true, see everyone's. */
const SHOTS = [
  {
    name: 'camera',
    alt: 'The app’s Check the numbers screen: a sign’s photo with a box on each number it read, and the numbers listed below it to check',
    title: 'The camera reads the numbers',
    text: 'Passenger mode boxes every number it can find. You check them before you start.'
  },
  {
    name: 'sign',
    alt: 'A sign in the app: its photo, its math on a green plate, who found it, and a heart',
    title: 'Find another way',
    text: 'Every sign can hold more than one way. The keypad has square roots, powers and stacked fractions, and says “It works” when it does.'
  },
  {
    name: 'home',
    alt: 'The app’s Home, sorted by Popular, with a sign’s photo and its math',
    title: 'Popular and nearby',
    text: 'See what others found, heart the good ones, and earn badges for the road.'
  }
] as const;

const FAQ = [
  ['Does it cost anything?', 'No. The beta is free.'],
  [
    'Do I need an account to look around?',
    'No. In the app you sign in only to post a sign, add a way or heart one. This site never asks you to.'
  ],
  [
    'What will other people see?',
    'Your player name and photo, the signs you post with their photos, your math and your badges. Never your email.'
  ],
  ['Android?', 'Not yet. This site shows every sign on any phone.']
] as const;

export function mountAppPage(site: Hono, { urls }: { urls: Urls }): void {
  for (const shot of SHOTS) {
    site.get(`/app/${shot.name}.webp`, (c) =>
      c.body(Buffer.from(APP_SHOTS[shot.name].webp, 'base64'), 200, {
        'Content-Type': 'image/webp',
        'Cache-Control': DAY
      })
    );
  }

  site.get('/app', (c) =>
    c.html(
      <Page
        title="The iPhone app · Road Sign Math"
        description="Road Sign Math lives in the iPhone app: point the camera at a sign, make its numbers true, and post it to the map. Join the free beta through TestFlight."
        url={`${urls.site}/app`}
        here="app"
        style={APP_STYLE}
      >
        <main id="main" class="getapp">
          <section class="hero">
            <div class="wrap">
              <div class="pitch">
                <p class="kicker">
                  <span class="mono">For iPhone</span>
                  <span class="beta">Beta</span>
                </p>
                <h1>The game lives in the app.</h1>
                <p class="lead">
                  Point the camera at a sign. It reads the numbers; you make them true. Post it, and it lands on the map
                  here and in everyone’s app.
                </p>
                <div class="join">
                  <a
                    class="testflight"
                    href={TESTFLIGHT_URL}
                    data-tinylytics-event="beta.join"
                    data-tinylytics-event-value="app"
                  >
                    <Phone size={22} />
                    <span>
                      Join the iPhone beta
                      <small>Free, through Apple’s TestFlight</small>
                    </span>
                  </a>
                  <p>Open this page on your iPhone, or scan the code.</p>
                </div>
              </div>
              <figure class="qr">
                <span
                  role="img"
                  aria-label="QR code for the iPhone beta"
                  dangerouslySetInnerHTML={{ __html: BETA_QR_SVG }}
                />
                <figcaption>Scan with your iPhone camera to join the beta</figcaption>
              </figure>
            </div>
          </section>

          <section class="does" aria-labelledby="does-h">
            <div class="wrap">
              <h2 id="does-h">What it does</h2>
              <ul class="shots">
                {SHOTS.map((s) => (
                  <li>
                    <span class="phone">
                      <img
                        src={`/app/${s.name}.webp`}
                        alt={s.alt}
                        width={APP_SHOTS[s.name].width}
                        height={APP_SHOTS[s.name].height}
                        loading="lazy"
                      />
                    </span>
                    <h3>{s.title}</h3>
                    <p>{s.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section class="joining" aria-labelledby="join-h">
            <div class="wrap">
              <div>
                <h2 id="join-h">Joining the beta</h2>
                <ol class="steps">
                  <li>
                    <span class="n mono" aria-hidden="true">
                      1
                    </span>
                    <h3>Get TestFlight</h3>
                    <p>Apple’s free app for trying beta apps. It’s in the App Store.</p>
                  </li>
                  <li>
                    <span class="n mono" aria-hidden="true">
                      2
                    </span>
                    <h3>Open the beta link on your iPhone</h3>
                    <p>Tap Join the iPhone beta on this page, then Accept in TestFlight.</p>
                  </li>
                  <li>
                    <span class="n mono" aria-hidden="true">
                      3
                    </span>
                    <h3>Install and sign in</h3>
                    <p>Sign in with your email: the app sends a code and a link. There’s no password.</p>
                  </li>
                </ol>
              </div>
              <dl class="faq">
                {FAQ.map(([q, a]) => (
                  <div>
                    <dt>{q}</dt>
                    <dd>{a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          <section class="how" aria-labelledby="how-h">
            <div class="wrap">
              <h2 id="how-h">How to play</h2>
              <ol>
                <li>
                  <h3>Spot a sign</h3>
                  <p>Any sign with numbers. The passenger takes the photo.</p>
                </li>
                <li>
                  <h3>Make it true</h3>
                  <p>Use the numbers with any math you like. It just has to be true.</p>
                </li>
                <li>
                  <h3>Put it on the map</h3>
                  <p>
                    It shows up on <a href="/">the map</a> and with <a href="/signs">every sign</a>, here and in the
                    app.
                  </p>
                </li>
              </ol>
            </div>
          </section>
        </main>
      </Page>
    )
  );
}
