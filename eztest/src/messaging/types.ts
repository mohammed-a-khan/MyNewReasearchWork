/** Email and SMS provider contracts used by "Get the latest email/SMS ..." steps. */

export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  /** Plain-text body (derived from HTML when the message has no text part). */
  text: string;
  html?: string;
  /** ISO timestamp the provider received the message. */
  date: string;
}

export interface MailQuery {
  /** Recipient address (case-insensitive substring match). */
  to?: string;
  /** Subject must contain this text. */
  subject?: string;
  /** Only messages received at or after this epoch ms. */
  since?: number;
  /** How long to poll for a matching message. Default 10000. */
  timeoutMs?: number;
  /** Poll interval. Default 250. */
  pollMs?: number;
}

export interface MailProvider {
  readonly name: string;
  /** The newest message matching the query, polling until one arrives or the timeout. */
  latest(q: MailQuery): Promise<EmailMessage>;
}

export interface SmsMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  date: string;
}

export interface SmsQuery {
  to?: string;
  from?: string;
  contains?: string;
  since?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface SmsProvider {
  readonly name: string;
  latest(q: SmsQuery): Promise<SmsMessage>;
}
