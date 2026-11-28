// The sign-in form's half of Cloudflare Turnstile (the server's is src/auth/turnstile.ts), for the
// website and Quiz, which draw the same form (`SignInPage` in pages.tsx).
//
// The form always carries `turnstile_reason` as `no-script`: a post with no script running (a
// person without scripts, or a crawler posting the form as drawn) says so. When the script runs it
// loads Cloudflare's widget into the form's slot, managed and interaction-only, so most people see
// nothing and a doubtful browser gets a checkbox in the slot. On submit it waits for the token (five
// seconds, or two minutes while a checkbox is showing), then posts the form with the token, how
// long it waited (`turnstile_wait_ms`) and, with no token, why (`turnstile_reason`):
// `script-blocked` (the script didn't load: a content blocker or the network), `script-empty`
// (it loaded without the API), `error:<code>` (Cloudflare's error callback), `loading-timeout` /
// `solving-timeout` / `interactive-timeout`, or `no-widget`. If the script can't load, the form
// still posts and the server decides. Release Notes' reasons, the same words.
//
// Cloudflare's first error is not the end. The widget retries on its own (`retry: 'auto'`, every
// `RETRY_INTERVAL_MS`, so a retry fits inside the five seconds), and Cloudflare documents most
// codes as retryable (600010 among them: Release Notes lost a real sign-in to it, posting at once
// with no token). So an error is only remembered, and the wait goes on; a token that comes later is
// posted as any other. Only when the wait runs out does the form go without a token, with the last
// error as its reason. Final at once, as before: a script that didn't load (`script-blocked`) or
// came without the API (`script-empty`), and the codes Cloudflare documents as never retried
// (`FINAL_CODES`: a bad or disabled site key, a hostname not allowed, a wrong clock), where waiting
// would only make a person wait. The error callback returns false, as Cloudflare's retry example
// does to "let Turnstile handle the retry" (a truthy return says the page handled the error itself).

import { TURNSTILE_SCRIPT_URL } from '../auth/turnstile.ts';

/** How often the widget retries after an error: under the five-second wait, so a retry fits in it (Cloudflare's default is 8 s). */
export const RETRY_INTERVAL_MS = 2000;

/**
 * The error codes Cloudflare documents as not retried (Turnstile's client-side error codes): the
 * widget can't recover from them, so they end the wait at once.
 */
export const FINAL_CODES = ['110100', '110110', '110200', '200100', '400020', '400021', '400070'];

/** The page's script for a form drawn with a Turnstile slot (`.ts-slot`, `data-sitekey`, `data-action`). */
export const TURNSTILE_JS = `(() => {
  const form = document.querySelector('form[data-turnstile]');
  const slot = form && form.querySelector('.ts-slot');
  if (!slot) return;
  const field = (name) => form.querySelector('input[name="' + name + '"]');
  const tokenField = field('turnstile_token'), reasonField = field('turnstile_reason'), waitField = field('turnstile_wait_ms');
  reasonField.value = 'no-widget';
  // final: why there will be no token, ending the wait at once. lastError: Cloudflare's newest
  // error, while its own retry may still bring a token; the reason only if the wait runs out.
  let token = '', final = '', lastError = '', interactive = false, loaded = false, waiters = [];
  const finalCodes = ${JSON.stringify(FINAL_CODES)};
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
  const quiet = (asking) => { slot.dataset.turnstile = asking ? 'asking' : 'quiet'; };
  quiet(false);
  window.rsmTurnstileLoaded = () => {
    loaded = true;
    const api = window.turnstile;
    if (!api || typeof api.render !== 'function') { final = 'script-empty'; wake(); return; }
    try {
      api.render(slot, {
        sitekey: slot.dataset.sitekey,
        action: slot.dataset.action,
        appearance: 'interaction-only',
        'refresh-expired': 'auto',
        retry: 'auto',
        'retry-interval': ${RETRY_INTERVAL_MS},
        'response-field': false,
        callback: (t) => { token = t; final = ''; lastError = ''; interactive = false; quiet(false); wake(); },
        'expired-callback': () => { token = ''; },
        'before-interactive-callback': () => { interactive = true; quiet(true); },
        'error-callback': (code) => {
          token = '';
          const clean = String(code || '').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'unknown';
          lastError = 'error:' + clean;
          interactive = false; quiet(false);
          if (finalCodes.indexOf(clean) !== -1) { final = lastError; wake(); }
          return false;
        }
      });
    } catch (e) { final = 'script-empty'; wake(); }
  };
  const script = document.createElement('script');
  script.src = '${TURNSTILE_SCRIPT_URL}?render=explicit&onload=rsmTurnstileLoaded';
  script.async = true;
  script.onerror = () => { final = 'script-blocked'; wake(); };
  document.head.appendChild(script);
  let sending = false, waiting = false;
  form.addEventListener('submit', (event) => {
    if (sending) return;
    event.preventDefault();
    // A second press while the first waits for its token starts no second wait: one press, one post.
    if (waiting) return;
    waiting = true;
    const started = Date.now();
    const send = (timedOut) => {
      sending = true;
      tokenField.value = token;
      waitField.value = String(Date.now() - started);
      reasonField.value = token ? '' : final || (timedOut
        ? lastError || (interactive ? 'interactive-timeout' : loaded ? 'solving-timeout' : 'loading-timeout')
        : 'no-widget');
      form.submit();
    };
    const poll = () => {
      if (token || final) return send(false);
      if (Date.now() - started >= (interactive ? 120000 : 5000)) return send(true);
      const timer = setTimeout(() => { waiters = waiters.filter((w) => w !== go); poll(); }, 250);
      const go = () => { clearTimeout(timer); poll(); };
      waiters.push(go);
    };
    poll();
  });
})();`;

/**
 * The slot's look: no room until Cloudflare asks for a checkbox, and none once answered. Height 0,
 * never display:none, so the widget's frame still runs while quiet (Release Notes' rule).
 */
export const TURNSTILE_STYLE = `.ts-slot[data-turnstile="quiet"]{height:0;overflow:hidden}`;
