// The sign-in email: a plain-text part and an HTML part saying the same things. The HTML is the
// app's look (the guide sign's green and white on the pale road-map ground, darker at night)
// built for mail readers: tables, inline styles, a small style block for dark mode, no script
// and no web fonts. Its one image is Tinylytics' 1x1 pixel, the same for every email, so opens
// are counted per email and never per person. The link and the code are the only things put in,
// both escaped.

import { tinylyticsPixel } from '../web/tinylytics.ts';
import type { Mail } from './mailer.ts';

/** Text made safe for HTML, in an element or a quoted attribute. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The Design boards' colours, as the app has them. The sign plate and the button stay green and
// white in both schemes, as a real sign does.
const SIGN_GREEN = '#006348';
const GROUND = '#f3f5f2';
const CARD = '#ffffff';
const INK = '#18201c';
const INK_2 = '#3b4540';
const INK_3 = '#55605a';
const RULE = '#d8ded9';
const POST = '#9aa59e';
const WAY_GROUND = '#e3efe9';
const WAY_INK = '#1f3a2e';

const FONT = "Overpass,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Overpass Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

// Apple Mail and iOS Mail follow the scheme; Outlook.com marks what it darkened with data-ogsc
// and data-ogsb. Gmail's apps darken on their own, so the green parts also carry their colour
// as a background image, which those apps leave alone.
const CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
@media (prefers-color-scheme: dark) {
  body, .ground { background: #0e1310 !important; }
  .card { background: #181f1b !important; border-color: #2a332e !important; }
  .ink { color: #e9eeea !important; }
  .ink-2 { color: #bac4be !important; }
  .ink-3 { color: #8e9993 !important; }
  .link { color: #5cc29a !important; }
  .code { background: #15291f !important; color: #cde8da !important; border-color: #24503c !important; }
  .rule { border-color: #2a332e !important; }
  .post { background: #3a453f !important; }
}
[data-ogsc] .ink { color: #e9eeea !important; }
[data-ogsc] .ink-2 { color: #bac4be !important; }
[data-ogsc] .ink-3 { color: #8e9993 !important; }
[data-ogsc] .link { color: #5cc29a !important; }
[data-ogsc] .code { color: #cde8da !important; }
[data-ogsb] .ground { background: #0e1310 !important; }
[data-ogsb] .card { background: #181f1b !important; }
[data-ogsb] .code { background: #15291f !important; }
@media (max-width: 520px) {
  .pad { padding-left: 22px !important; padding-right: 22px !important; }
  .digits { font-size: 34px !important; letter-spacing: 0.22em !important; }
  .plate-words { font-size: 21px !important; }
}
`;

const green = `background-color:${SIGN_GREEN};background-image:linear-gradient(${SIGN_GREEN},${SIGN_GREEN});`;

// Kept apart from the preheader so a preview shows the code, not the start of the page.
const PREVIEW_STOP = '&#847;&zwnj;&nbsp;'.repeat(40);

/** The guide sign: white words on green, inside a white border, on two posts. */
const plate = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
<tr><td style="${green}border-radius:16px;padding:6px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="plate-words" align="center" style="border:3px solid #ffffff;border-radius:11px;padding:14px 26px 12px;font-family:${FONT};font-size:25px;line-height:1.2;font-weight:800;letter-spacing:0.01em;color:#ffffff;white-space:nowrap;">Driving + Math = Fun</td>
</tr></table>
</td></tr>
<tr><td align="center" style="padding:0;font-size:0;line-height:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="post" width="10" height="22" style="width:10px;height:22px;background:${POST};font-size:0;line-height:0;">&nbsp;</td>
<td width="96" style="width:96px;font-size:0;line-height:0;">&nbsp;</td>
<td class="post" width="10" height="22" style="width:10px;height:22px;background:${POST};font-size:0;line-height:0;">&nbsp;</td>
</tr></table>
</td></tr>
</table>`;

function html(link: string, code: string): string {
  const href = escapeHtml(link);
  const digits = escapeHtml(code);
  const site = escapeHtml(new URL(link).origin);
  const host = escapeHtml(new URL(link).host);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>Your Road Sign Math code is ${digits}</title>
<style>${CSS}</style>
</head>
<body class="ground" style="margin:0;padding:0;background:${GROUND};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${GROUND};">Your code is ${digits}. It works for 15 minutes.${PREVIEW_STOP}</div>
<table role="presentation" class="ground" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
<tr><td align="center" style="padding:36px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 0 0;">
${plate}
</td></tr>
<tr><td class="card" style="background:${CARD};border:1px solid ${RULE};border-radius:18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="pad" style="padding:34px 40px 8px;">
<h1 class="ink" style="margin:0 0 10px;font-family:${FONT};font-size:26px;line-height:1.2;font-weight:800;color:${INK};">Sign in to Road Sign Math</h1>
<p class="ink-2" style="margin:0 0 24px;font-family:${FONT};font-size:17px;line-height:1.5;color:${INK_2};">Tap the button on your iPhone to sign in.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="${green}border-radius:14px;">
<a href="${href}" style="display:block;padding:16px 24px;font-family:${FONT};font-size:19px;line-height:1.2;font-weight:800;color:#ffffff;text-decoration:none;border-radius:14px;">Sign in</a>
</td></tr>
</table>
</td></tr>
<tr><td class="pad" style="padding:26px 40px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="50%" valign="middle"><div class="rule" style="border-top:1px solid ${RULE};height:0;font-size:0;line-height:0;">&nbsp;</div></td>
<td class="ink-3" valign="middle" style="padding:0 12px;white-space:nowrap;font-family:${FONT};font-size:14px;line-height:1;color:${INK_3};">Or type this code in the app</td>
<td width="50%" valign="middle"><div class="rule" style="border-top:1px solid ${RULE};height:0;font-size:0;line-height:0;">&nbsp;</div></td>
</tr></table>
</td></tr>
<tr><td class="pad" align="center" style="padding:18px 40px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="code digits" align="center" style="background:${WAY_GROUND};border:1px solid #c9ddd2;border-radius:14px;padding:18px 0 16px 0.3em;font-family:${MONO};font-size:40px;line-height:1;font-weight:700;letter-spacing:0.3em;color:${WAY_INK};">${digits}</td>
</tr></table>
</td></tr>
<tr><td class="pad" style="padding:22px 40px 34px;">
<p class="ink-3" style="margin:0;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK_3};text-align:center;">It works for 15 minutes. If you didn&rsquo;t ask to sign in, you can ignore this email.</p>
</td></tr>
</table>
</td></tr>
<tr><td class="pad" style="padding:22px 40px 0;">
<p class="ink-3" style="margin:0 0 4px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK_3};text-align:center;">If the button doesn&rsquo;t work, open this link on your iPhone:</p>
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;text-align:center;word-break:break-all;"><a class="link" href="${href}" style="color:${SIGN_GREEN};text-decoration:underline;">${href}</a></p>
</td></tr>
<tr><td align="center" style="padding:26px 24px 0;">
<p class="ink-3" style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK_3};"><a class="link" href="${site}" style="color:${SIGN_GREEN};font-weight:700;text-decoration:none;">Road Sign Math</a> &middot; ${host}</p>
</td></tr>
</table>
</td></tr>
</table>
<img src="${escapeHtml(tinylyticsPixel('/email/signin'))}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;" />
</body>
</html>
`;
}

/** The email that carries a sign-in link and code. */
export function signInMail(to: string, link: string, code: string): Mail {
  return {
    to,
    subject: `Your Road Sign Math code is ${code}`,
    text:
      `Tap to sign in to Road Sign Math on your iPhone:\n${link}\n\n` +
      `Or type this code in the app: ${code}\n\n` +
      `It works for 15 minutes. If you didn't ask to sign in, you can ignore this email.\n`,
    html: html(link, code)
  };
}
