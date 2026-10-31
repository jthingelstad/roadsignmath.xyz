import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { FileMailer, SesMailer } from '../src/mail/mailer.ts';
import { escapeHtml, signInMail } from '../src/mail/signin.ts';

const link = 'https://example.test/signin?l=01JLOGIN&t=secret-token_value';

test('the sign-in email says the same in text as before, and in HTML', () => {
  const mail = signInMail('player@example.test', link, '048213');
  assert.equal(mail.subject, 'Your Road Sign Math code is 048213');
  assert.equal(
    mail.text,
    `Tap to sign in to Road Sign Math on your iPhone:\n${link}\n\n` +
      'Or type this code in the app: 048213\n\n' +
      "It works for 15 minutes. If you didn't ask to sign in, you can ignore this email.\n"
  );
  const html = mail.html!;
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /prefers-color-scheme: dark/);
  // The button and the fallback both carry the link, its & escaped.
  const escaped = 'https://example.test/signin?l=01JLOGIN&amp;t=secret-token_value';
  assert.equal(html.split(`href="${escaped}"`).length - 1, 2);
  assert.match(html, />Sign in<\/a>/);
  assert.match(html, /Your code is 048213\. It works for 15 minutes\./, 'the preheader');
  assert.match(html, />048213<\/td>/);
  assert.match(html, /Or type this code in the app/);
  assert.match(html, /It works for 15 minutes\. If you didn&rsquo;t ask to sign in, you can ignore this email\./);
  assert.match(html, /Driving \+ Math = Fun/);
  // Nothing to run and nothing remote but the counting pixel: no scripts, web fonts or styles.
  assert.doesNotMatch(html, /<script|<link|@import|url\(/i);
  const images = [...html.matchAll(/<img [^>]*src="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(images, ['https://tinylytics.app/pixel/ryhTaXDDgZtyCktoVzzj.gif?path=/email/signin']);
  assert.ok(!html.includes('player@example.test'), 'the address is not in the body');
});

test('everything put into the HTML is escaped', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const odd = `https://example.test/signin?l="><script>alert(1)</script>&t='x'`;
  const html = signInMail('player@example.test', odd, '<b>1</b>').html!;
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<b>1</b>'));
  assert.match(
    html,
    /href="https:\/\/example\.test\/signin\?l=&quot;&gt;&lt;script&gt;/,
    'the quote stays in the attribute'
  );
  assert.match(html, /&amp;t=&#39;x&#39;"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;1&lt;\/b&gt;/);
});

test('SES gets both parts, and text alone when there is no HTML', async () => {
  const sent: SendEmailCommand['input'][] = [];
  const client = { send: async (command: SendEmailCommand) => void sent.push(command.input) };
  const mailer = new SesMailer('Road Sign Math <signin@example.test>', client as never);
  await mailer.send(signInMail('player@example.test', link, '048213'));
  await mailer.send({ to: 'player@example.test', subject: 'Plain', text: 'Just text' });
  const [both, plain] = sent.map((input) => input.Content!.Simple!.Body!);
  assert.match(both.Text!.Data!, /048213/);
  assert.match(both.Html!.Data!, /048213/);
  assert.equal(both.Html!.Charset, 'UTF-8');
  assert.deepEqual(plain, { Text: { Data: 'Just text', Charset: 'UTF-8' } });
  assert.deepEqual(sent[0].Destination, { ToAddresses: ['player@example.test'] });
});

test('in dev the HTML lands beside the text, to open in a browser', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rsm-mail-'));
  try {
    const log = console.log;
    console.log = () => {};
    try {
      await new FileMailer(folder).send(signInMail('player@example.test', link, '048213'));
    } finally {
      console.log = log;
    }
    const files = (await readdir(folder)).sort();
    assert.equal(files.length, 2);
    assert.ok(files[0].endsWith('.html') && files[1].endsWith('.txt'));
    assert.equal(files[0].replace(/\.html$/, ''), files[1].replace(/\.txt$/, ''));
    assert.match(await readFile(join(folder, files[0]), 'utf8'), /^<!doctype html>/);
    assert.match(await readFile(join(folder, files[1]), 'utf8'), /^To: player@example\.test\nSubject: Your Road/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
