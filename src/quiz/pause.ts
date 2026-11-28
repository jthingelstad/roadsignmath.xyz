// The pause a sign-in form asks for: a POST that arrives sooner after its form was drawn than
// anyone types an email address sends no email. From 21 to 28 November 2026 a crawler loaded the
// website's sign-in form 40 times and posted each one 0.7 to 1.8 seconds later, with an address
// of its own making: 40 sign-in emails to people who never asked, under every limit in
// src/auth/auth.ts.
//
// The form carries when it was drawn (`at`, a hidden field, the server's clock in base 36). It is
// not signed and proves nothing about who sent it: it only tells a form filled and fired at once
// from one a person read. A refusal draws the form again with what was typed and a stamp already
// old enough, so a person who was that quick (or whose form sat open past a day) presses the
// button once more and is through. The limits stay the real ceiling.

/** The least time between a sign-in form being drawn and its POST, in milliseconds, as live. */
export const SIGN_IN_PAUSE = 3000;

/** The form's `at` for a form drawn at `now`. */
export const formStamp = (now: number = Date.now()): string => Math.max(0, Math.floor(now)).toString(36);

/** How long a drawn form's stamp is taken: a day, in milliseconds. */
export const STAMP_KEPT = 86_400_000;

/**
 * Whether a form stamped `at` came back within `pause` milliseconds of being drawn. A stamp that
 * is missing, isn't one, is from later than now or is more than a day old is refused as well.
 */
export function tooQuick(at: string, pause: number, now: number = Date.now()): boolean {
  if (pause <= 0) return false;
  if (!/^[0-9a-z]{1,11}$/.test(at)) return true;
  const age = now - parseInt(at, 36);
  return age < pause || age > STAMP_KEPT;
}
