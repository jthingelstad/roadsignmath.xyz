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

import { TURNSTILE_SCRIPT_URL } from '../auth/turnstile.ts';

/** The page's script for a form drawn with a Turnstile slot (`.ts-slot`, `data-sitekey`, `data-action`). */
export const TURNSTILE_JS = `(() => {
  const form = document.querySelector('form[data-turnstile]');
  const slot = form && form.querySelector('.ts-slot');
  if (!slot) return;
  const field = (name) => form.querySelector('input[name="' + name + '"]');
  const tokenField = field('turnstile_token'), reasonField = field('turnstile_reason'), waitField = field('turnstile_wait_ms');
  reasonField.value = 'no-widget';
  let token = '', failure = '', interactive = false, loaded = false, waiters = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
  const quiet = (asking) => { slot.dataset.turnstile = asking ? 'asking' : 'quiet'; };
  quiet(false);
  window.rsmTurnstileLoaded = () => {
    loaded = true;
    const api = window.turnstile;
    if (!api || typeof api.render !== 'function') { failure = 'script-empty'; wake(); return; }
    try {
      api.render(slot, {
        sitekey: slot.dataset.sitekey,
        action: slot.dataset.action,
        appearance: 'interaction-only',
        'refresh-expired': 'auto',
        'response-field': false,
        callback: (t) => { token = t; failure = ''; interactive = false; quiet(false); wake(); },
        'expired-callback': () => { token = ''; },
        'before-interactive-callback': () => { interactive = true; quiet(true); },
        'error-callback': (code) => {
          token = '';
          failure = 'error:' + (String(code || '').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'unknown');
          interactive = false; quiet(false); wake();
        }
      });
    } catch (e) { failure = 'script-empty'; wake(); }
  };
  const script = document.createElement('script');
  script.src = '${TURNSTILE_SCRIPT_URL}?render=explicit&onload=rsmTurnstileLoaded';
  script.async = true;
  script.onerror = () => { failure = 'script-blocked'; wake(); };
  document.head.appendChild(script);
  let sending = false;
  form.addEventListener('submit', (event) => {
    if (sending) return;
    event.preventDefault();
    const started = Date.now();
    const send = (timedOut) => {
      sending = true;
      tokenField.value = token;
      waitField.value = String(Date.now() - started);
      reasonField.value = token ? '' : failure || (timedOut
        ? (interactive ? 'interactive-timeout' : loaded ? 'solving-timeout' : 'loading-timeout')
        : 'no-widget');
      form.submit();
    };
    const poll = () => {
      if (token || failure) return send(false);
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
