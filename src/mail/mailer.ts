// Sending mail. The live server sends through SES from the roadsignmath.xyz domain; `npm run dev`
// writes each message to .data/mail/ instead; tests keep them in memory.

import { mkdir, writeFile } from 'node:fs/promises';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

export type Mail = { to: string; subject: string; text: string };

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class SesMailer implements Mailer {
  private readonly client = new SESv2Client({});

  constructor(private readonly from: string) {}

  async send(mail: Mail): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [mail.to] },
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: mail.text, Charset: 'UTF-8' } }
          }
        }
      })
    );
  }
}

/** For `npm run dev`: one text file per message in .data/mail/. */
export class FileMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    await mkdir('.data/mail', { recursive: true });
    const file = `.data/mail/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    await writeFile(file, `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
    console.log(`Mail written to ${file}`);
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}
