import { load } from "cheerio";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { MailAddress, MailAttachment } from "./types.js";

export const MAX_MESSAGE_TEXT_CHARS = 20_000;
export const MAX_TOTAL_BODY_CHARS = 200_000;
export const MAX_ATTACHMENT_METADATA = 50;
export const MAX_BODY_BYTES = 64 * 1024;

export interface ParsedMailBody {
  textBody: string;
  truncated: boolean;
  attachments: MailAttachment[];
}

export async function parseMailSource(source: Buffer, sourceMayBeTruncated = false): Promise<ParsedMailBody> {
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(source, { skipHtmlToText: false });
  } catch {
    throw new Error("MIME parsing failed");
  }
  const rawText = parsed.text?.trim() || htmlToText(parsed.html) || "";
  const cleanText = stripControlCharacters(rawText).replace(/\r\n?/g, "\n").trim();
  const truncated = sourceMayBeTruncated || cleanText.length > MAX_MESSAGE_TEXT_CHARS;
  return {
    textBody: cleanText.slice(0, MAX_MESSAGE_TEXT_CHARS),
    truncated,
    attachments: parsed.attachments.slice(0, MAX_ATTACHMENT_METADATA).map((attachment) => ({
      name: stripControlCharacters(attachment.filename || "attachment"),
      ...(attachment.contentType ? { contentType: stripControlCharacters(attachment.contentType) } : {}),
      ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
    })),
  };
}

export function addressList(addresses: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!addresses) return [];
  const values = Array.isArray(addresses) ? addresses : [addresses];
  return values.flatMap((address) => address.value.map((entry) => ({
    ...(entry.name ? { name: stripControlCharacters(entry.name) } : {}),
    ...(entry.address ? { address: stripControlCharacters(entry.address) } : {}),
  })));
}

export function stripControlCharacters(value: string): string {
  return value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function htmlToText(value: string | false | undefined): string {
  if (!value) return "";
  const document = load(value);
  document("script,style,noscript,template").remove();
  return document.root().text().replace(/\s+/g, " ").trim();
}
