import { AuthenticationFailure, ImapFlow, type FetchMessageObject, type MessageStructureObject, type SearchObject } from "imapflow";
import { loadStoredMailCredentials, type CredentialStoreOptions, type StoredMailCredentials } from "../core/keyring.js";
import { CliError } from "../core/errors.js";
import {
  MAX_BODY_BYTES,
  MAX_TOTAL_BODY_CHARS,
  parseMailSource,
  stripControlCharacters,
} from "./mime.js";
import type {
  MailAddress,
  MailCredentials,
  MailFolder,
  MailMessage,
  MailReadOptions,
  MailSearchOptions,
  MailSummary,
} from "./types.js";

export const MAIL_IMAP_HOST = "imap.exmail.qq.com";
export const MAIL_IMAP_PORT = 993;
export const MAIL_IMAP_TIMEOUT_MS = 30_000;
export const MAIL_MAX_MESSAGES_PER_READ = 20;

export interface MailClientOptions {
  credentialStore?: CredentialStoreOptions;
  clientFactory?: (credentials: MailCredentials) => ImapFlow;
}

export class MailClient {
  private readonly options: MailClientOptions;

  public constructor(options: MailClientOptions = {}) {
    this.options = options;
  }

  public async verifyCredentials(credentials: MailCredentials): Promise<void> {
    const client = this.createClient(credentials);
    try {
      await client.connect();
    } catch (error) {
      throw mailConnectionError(error, "authentication");
    } finally {
      await closeClient(client);
    }
  }

  public async verifyStoredCredentials(profile?: string): Promise<{ credentials: StoredMailCredentials; backend: string }> {
    const stored = await loadStoredMailCredentials(profile, this.options.credentialStore);
    await this.verifyCredentials({ ...stored, source: "system-keyring" });
    return { credentials: stored, backend: stored.backend };
  }

  public async folders(credentials: MailCredentials): Promise<MailFolder[]> {
    return await this.withClient(credentials, async (client) => {
      try {
        const entries = await client.list({ statusQuery: { unseen: true, uidValidity: true } });
        return entries.map((entry) => ({
          displayName: stripControlCharacters(entry.name || entry.path),
          imapName: stripControlCharacters(entry.path),
          ...(entry.specialUse ? { specialUse: stripControlCharacters(entry.specialUse) } : {}),
          ...(entry.status?.unseen !== undefined ? { unreadCount: entry.status.unseen } : {}),
        }));
      } catch (error) {
        throw mailConnectionError(error, "list folders");
      }
    });
  }

  public async search(credentials: MailCredentials, options: MailSearchOptions = {}): Promise<MailSummary[] | MailMessage[]> {
    const limit = options.limit ?? 20;
    if (limit < 1 || limit > 50) throw new CliError("--limit must be between 1 and 50.", "MAIL_SEARCH_INVALID", 2);
    if (options.includeBody && limit > MAIL_MAX_MESSAGES_PER_READ) throw new CliError(`--limit cannot exceed ${MAIL_MAX_MESSAGES_PER_READ} with --include-body.`, "MAIL_SEARCH_INVALID", 2);
    return await this.withClient(credentials, async (client) => {
      const folder = await this.resolveFolder(client, options.folder ?? "INBOX");
      let lock;
      try {
        lock = await client.getMailboxLock(folder.imapName);
        const criteria = buildSearchCriteria(options);
        const result = await client.search(criteria, { uid: true });
        const uids = (Array.isArray(result) ? result : []).sort((left, right) => right - left).slice(0, limit);
        if (uids.length === 0) return [];
        const uidValidity = currentUidValidity(client);
        const query = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true } as const;
        const fetched = await client.fetchAll(uids, query, { uid: true });
        const summaries = fetched.sort((left, right) => right.uid - left.uid).map((message) => summarizeMessage(message, folder.imapName, uidValidity));
        if (!options.includeBody) return summaries;
        const messages: MailMessage[] = [];
        let totalBodyChars = 0;
        for (const summary of summaries) {
          const fetchedMessage = await client.fetchOne(summary.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, source: { start: 0, maxLength: MAX_BODY_BYTES } }, { uid: true });
          if (!fetchedMessage) throw new CliError(`Message UID ${summary.uid} was not found.`, "MAIL_MESSAGE_NOT_FOUND", 2, { folder: folder.imapName, uid: summary.uid });
          const message = await parseFetchedMessage(fetchedMessage, folder.imapName, uidValidity, fetchedMessage.source?.length === MAX_BODY_BYTES);
          const remaining = Math.max(0, MAX_TOTAL_BODY_CHARS - totalBodyChars);
          if (message.textBody.length > remaining) {
            message.textBody = message.textBody.slice(0, remaining);
            message.truncated = true;
          }
          totalBodyChars += message.textBody.length;
          messages.push(message);
        }
        return messages;
      } catch (error) {
        throw mapMailOperationError(error, "search");
      } finally {
        lock?.release();
      }
    });
  }

  public async read(credentials: MailCredentials, options: MailReadOptions): Promise<MailMessage> {
    if (!Number.isSafeInteger(options.uid) || options.uid <= 0) throw new CliError("--uid must be a positive integer.", "MAIL_SEARCH_INVALID", 2);
    return await this.withClient(credentials, async (client) => {
      let lock;
      try {
        const folder = await this.resolveFolder(client, options.folder);
        lock = await client.getMailboxLock(folder.imapName);
        const uidValidity = currentUidValidity(client);
        if (options.uidValidity && options.uidValidity !== uidValidity) {
          throw new CliError("The mailbox UIDVALIDITY changed since the message was found.", "MAIL_UID_VALIDITY_CHANGED", 2, { folder: folder.imapName, expected: options.uidValidity, actual: uidValidity });
        }
        const fetched = await client.fetchOne(options.uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, source: { start: 0, maxLength: MAX_BODY_BYTES } }, { uid: true });
        if (!fetched) throw new CliError(`Message UID ${options.uid} was not found.`, "MAIL_MESSAGE_NOT_FOUND", 2, { folder: folder.imapName, uid: options.uid });
        return await parseFetchedMessage(fetched, folder.imapName, uidValidity, fetched.source?.length === MAX_BODY_BYTES);
      } catch (error) {
        throw mapMailOperationError(error, "read");
      } finally {
        lock?.release();
      }
    });
  }

  private createClient(credentials: MailCredentials): ImapFlow {
    if (this.options.clientFactory) return this.options.clientFactory(credentials);
    return new ImapFlow({
      host: MAIL_IMAP_HOST,
      port: MAIL_IMAP_PORT,
      secure: true,
      auth: { user: credentials.email, pass: credentials.password },
      connectionTimeout: MAIL_IMAP_TIMEOUT_MS,
      greetingTimeout: MAIL_IMAP_TIMEOUT_MS,
      socketTimeout: MAIL_IMAP_TIMEOUT_MS,
      logger: false,
    });
  }

  private async withClient<T>(credentials: MailCredentials, operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.createClient(credentials);
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      throw mapMailOperationError(error, "connection");
    } finally {
      await closeClient(client);
    }
  }

  private async resolveFolder(client: ImapFlow, requested: string): Promise<MailFolder> {
    const entries = await client.list({ statusQuery: { unseen: true, uidValidity: true } });
    const normalized = requested.trim();
    const entry = entries.find((candidate) => candidate.path === normalized || candidate.name === normalized || (normalized.toUpperCase() === "INBOX" && candidate.specialUse?.toLowerCase() === "\\inbox"));
    if (!entry) throw new CliError(`Mail folder '${stripControlCharacters(requested)}' was not found.`, "MAIL_FOLDER_NOT_FOUND", 2, { folder: stripControlCharacters(requested) });
    return {
      displayName: stripControlCharacters(entry.name || entry.path),
      imapName: stripControlCharacters(entry.path),
      ...(entry.specialUse ? { specialUse: stripControlCharacters(entry.specialUse) } : {}),
      ...(entry.status?.unseen !== undefined ? { unreadCount: entry.status.unseen } : {}),
    };
  }
}

function buildSearchCriteria(options: MailSearchOptions): SearchObject {
  const criteria: SearchObject = { all: true };
  if (options.unread) criteria.seen = false;
  if (options.from) criteria.from = options.from;
  if (options.to) criteria.to = options.to;
  if (options.subject) criteria.subject = options.subject;
  if (options.since) criteria.since = options.since;
  if (options.until) criteria.before = nextDate(options.until);
  return criteria;
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function summarizeMessage(message: FetchMessageObject, folder: string, uidValidity: string): MailSummary {
  return {
    folder,
    uid: message.uid,
    uidValidity,
    ...(message.envelope?.messageId ? { messageId: stripControlCharacters(message.envelope.messageId) } : {}),
    from: addresses(message.envelope?.from),
    to: addresses(message.envelope?.to),
    cc: addresses(message.envelope?.cc),
    subject: stripControlCharacters(message.envelope?.subject ?? ""),
    ...(dateString(message.internalDate ?? message.envelope?.date) ? { date: dateString(message.internalDate ?? message.envelope?.date) } : {}),
    flags: [...(message.flags ?? [])].map(stripControlCharacters),
    hasAttachments: hasAttachments(message.bodyStructure),
    ...(message.size !== undefined ? { size: message.size } : {}),
  };
}

async function parseFetchedMessage(message: FetchMessageObject, folder: string, uidValidity: string, sourceMayBeTruncated: boolean): Promise<MailMessage> {
  if (!message.source) throw new CliError("The message body was not returned by the IMAP server.", "MAIL_MESSAGE_PARSE_FAILED", 1);
  const summary = summarizeMessage(message, folder, uidValidity);
  let body;
  try {
    body = await parseMailSource(message.source, sourceMayBeTruncated);
  } catch {
    throw new CliError("The message MIME structure could not be parsed.", "MAIL_MESSAGE_PARSE_FAILED", 1, { folder, uid: message.uid });
  }
  return { ...summary, textBody: body.textBody, truncated: body.truncated, attachmentNames: body.attachments.map((attachment) => attachment.name), attachments: body.attachments };
}

function addresses(values: { name?: string; address?: string }[] | undefined): MailAddress[] {
  return (values ?? []).map((value) => ({
    ...(value.name ? { name: stripControlCharacters(value.name) } : {}),
    ...(value.address ? { address: stripControlCharacters(value.address) } : {}),
  }));
}

function dateString(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hasAttachments(structure: MessageStructureObject | undefined): boolean {
  if (!structure) return false;
  if (structure.disposition?.toLowerCase() === "attachment" || Boolean(structure.dispositionParameters?.filename)) return true;
  return (structure.childNodes ?? []).some((child) => hasAttachments(child));
}

function currentUidValidity(client: ImapFlow): string {
  if (!client.mailbox) return "";
  const value = client.mailbox.uidValidity;
  return value === undefined ? "" : String(value);
}

function mapMailOperationError(error: unknown, operation: string): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof AuthenticationFailure || /authentication|login|invalid credentials/i.test(errorMessage(error))) return new CliError("The mail server rejected the supplied credentials.", "MAIL_AUTH_FAILED", 2, { stage: operation });
  if (/certificate|tls|hostname|secure connection/i.test(errorMessage(error))) return new CliError("The secure IMAPS connection could not be established.", "MAIL_TLS_ERROR", 2, { stage: operation, host: MAIL_IMAP_HOST });
  if (/timeout|timed out|deadline/i.test(errorMessage(error))) return new CliError("The mail server request timed out.", operation === "read" ? "MAIL_READ_TIMEOUT" : "MAIL_IMAP_UNAVAILABLE", 2, { stage: operation, timeoutMs: MAIL_IMAP_TIMEOUT_MS });
  return new CliError("The mail server is unavailable or closed the connection.", "MAIL_IMAP_UNAVAILABLE", 2, { stage: operation, host: MAIL_IMAP_HOST });
}

function mailConnectionError(error: unknown, stage: string): CliError {
  return mapMailOperationError(error, stage);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeClient(client: ImapFlow): Promise<void> {
  if (client.isClosed) return;
  if (client.usable) {
    try {
      await client.logout();
    } catch {
      // Fall through to an ungraceful close when LOGOUT cannot complete.
    }
  }
  if (!client.isClosed) client.close();
}
