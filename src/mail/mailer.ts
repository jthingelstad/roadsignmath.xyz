// Sending mail. The live server sends through SES from the roadsignmath.xyz domain; `npm run dev`
// writes each message to .data/mail/ instead (the text, and the HTML beside it to open in a
// browser); tests keep them in memory.

import { mkdir, writeFile } from 'node:fs/promises';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

/**
 * A message: always a plain-text part, and an HTML part saying the same when there is one.
 * `replyTo` is where a reply goes instead of the sender, when there is somewhere.
 */
export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string };

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class SesMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly client: Pick<SESv2Client, 'send'> = new SESv2Client({})
  ) {}

  async send(mail: Mail): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [mail.to] },
        ...(mail.replyTo === undefined ? {} : { ReplyToAddresses: [mail.replyTo] }),
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: mail.text, Charset: 'UTF-8' },
              ...(mail.html === undefined ? {} : { Html: { Data: mail.html, Charset: 'UTF-8' } })
            }
          }
        }
      })
    );
  }
}

/** For `npm run dev`: one text file per message in .data/mail/, and its HTML beside it. */
export class FileMailer implements Mailer {
  constructor(private readonly folder = '.data/mail') {}

  async send(mail: Mail): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const base = `${this.folder}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const replyTo = mail.replyTo === undefined ? '' : `Reply-To: ${mail.replyTo}\n`;
    await writeFile(`${base}.txt`, `To: ${mail.to}\n${replyTo}Subject: ${mail.subject}\n\n${mail.text}`);
    if (mail.html !== undefined) await writeFile(`${base}.html`, mail.html);
    console.log(`Mail written to ${base}.txt${mail.html === undefined ? '' : ' and .html'}`);
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}
