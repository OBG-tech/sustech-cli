export type MailCredentialSource = "system-keyring";

export interface MailCredentials {
  email: string;
  password: string;
  profile: string;
  source: MailCredentialSource;
  backend?: string;
}

export interface MailAddress {
  name?: string;
  address?: string;
}

export interface MailFolder {
  displayName: string;
  imapName: string;
  specialUse?: string;
  unreadCount?: number;
}

export interface MailSummary {
  folder: string;
  uid: number;
  uidValidity?: string;
  messageId?: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  date?: string;
  flags: string[];
  hasAttachments: boolean;
  size?: number;
}

export interface MailMessage extends MailSummary {
  textBody: string;
  truncated: boolean;
  attachmentNames: string[];
  attachments: MailAttachment[];
}

export interface MailAttachment {
  name: string;
  contentType?: string;
  size?: number;
}

export interface MailSearchOptions {
  folder?: string;
  unread?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  until?: string;
  limit?: number;
  includeBody?: boolean;
}

export interface MailReadOptions {
  folder: string;
  uid: number;
  uidValidity?: string;
}
