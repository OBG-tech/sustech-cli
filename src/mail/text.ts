import { stripControlCharacters } from "./mime.js";
import type { MailFolder, MailMessage, MailSummary } from "./types.js";

export function formatMailFolders(folders: readonly MailFolder[]): string {
  if (folders.length === 0) return "Mail folders\n  (none)";
  return [
    `Mail folders · ${folders.length}`,
    ...folders.map((folder) => [
      `${safe(folder.displayName)}${folder.specialUse ? ` [${safe(folder.specialUse)}]` : ""}`,
      `  IMAP       ${safe(folder.imapName)}`,
      ...(folder.unreadCount !== undefined ? [`  Unread     ${folder.unreadCount}`] : []),
    ].join("\n")),
  ].join("\n\n");
}

export function formatMailSummaries(messages: readonly MailSummary[], title = "Mail search"): string {
  if (messages.length === 0) return `${title} · 0\n  (none)`;
  return [
    `${title} · ${messages.length}`,
    ...messages.map((message) => [
      `${message.uid}  ${safe(message.subject || "(no subject)")}`,
      `  From       ${formatAddresses(message.from)}`,
      `  To         ${formatAddresses(message.to)}`,
      ...(message.date ? [`  Date       ${safe(message.date)}`] : []),
      `  Folder     ${safe(message.folder)}`,
      `  Flags      ${message.flags.map(safe).join(", ") || "—"}`,
      `  Attachments ${message.hasAttachments ? "yes" : "no"}`,
    ].join("\n")),
  ].join("\n\n");
}

export function formatMailMessage(message: MailMessage): string {
  return [
    `${safe(message.subject || "(no subject)")} · UID ${message.uid}`,
    `From: ${formatAddresses(message.from)}`,
    `To: ${formatAddresses(message.to)}`,
    ...(message.cc.length > 0 ? [`Cc: ${formatAddresses(message.cc)}`] : []),
    ...(message.date ? [`Date: ${safe(message.date)}`] : []),
    `Folder: ${safe(message.folder)}`,
    ...(message.attachmentNames.length > 0 ? [`Attachments: ${message.attachmentNames.map(safe).join(", ")}`] : []),
    "",
    safe(message.textBody),
    ...(message.truncated ? ["", "[body truncated]"] : []),
  ].join("\n");
}

function formatAddresses(addresses: readonly { name?: string; address?: string }[]): string {
  return addresses.map((address) => address.name && address.address ? `${safe(address.name)} <${safe(address.address)}>` : safe(address.address ?? address.name ?? "—")).join(", ") || "—";
}

function safe(value: string): string {
  return stripControlCharacters(value);
}
