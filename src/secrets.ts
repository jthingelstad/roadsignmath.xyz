// The live server's credentials are keys in the runtime secret, which the owner keeps by hand
// in Secrets Manager: ANTHROPIC_API_KEY, the moderator's, TINYLYTICS_API_KEY, for hearts and
// the app's views, and BUTTONDOWN_API_KEY, for the players' newsletter. The stack names the secret (RUNTIME_SECRET) and lets the server read it and
// nothing else. A missing secret or key reads as none, so the server starts and answers without
// it: posting waits for the first, hearts and app views are off without the second, and
// without the third no one joins or leaves the newsletter.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

type Client = Pick<SecretsManagerClient, 'send'>;

/** One string field of a JSON secret, or undefined when the secret, the field or its value is missing. */
export async function secretField(secretId: string, field: string, client: Client = new SecretsManagerClient({})) {
  let raw: string | undefined;
  try {
    raw = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
  if (!raw) return undefined;
  let fields: unknown;
  try {
    fields = JSON.parse(raw);
  } catch {
    // Never the error itself: its message can quote the secret.
    throw new Error('The runtime secret is not JSON');
  }
  const value = (fields as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
