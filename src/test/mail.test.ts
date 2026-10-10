import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImapFlow } from "imapflow";
import {
  deleteStoredMailCredentials,
  getMailProfileStatus,
  loadStoredMailCredentials,
  saveStoredMailCredentials,
  type SecretStore,
} from "../core/keyring.js";
import { MailClient } from "../mail/client.js";
import { parseMailSource } from "../mail/mime.js";
import type { MailCredentials } from "../mail/types.js";

class MemoryMailStore implements SecretStore {
  public readonly backend = "macos-keychain" as const;
  public readonly persistent = true as const;
  private readonly values = new Map<string, string>();

  public async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }

  public async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  public async set(account: string, password: string): Promise<void> {
    this.values.set(account, password);
  }

  public async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

test("mail credentials use an independent namespace and keep secrets out of metadata", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "sustech-cli-mail-"));
  const store = new MemoryMailStore();
  try {
    await saveStoredMailCredentials({ profile: "student", email: "12010100@mail.sustech.edu.cn", password: "mail-secret" }, { configDir, store });
    const metadata = await readFile(join(configDir, "mail-profiles.json"), "utf8");
    assert.doesNotMatch(metadata, /mail-secret/u);
    assert.match(metadata, /12010100@mail\.sustech\.edu\.cn/u);
    assert.deepEqual(await loadStoredMailCredentials("student", { configDir, store }), {
      email: "12010100@mail.sustech.edu.cn",
      password: "mail-secret",
      profile: "student",
      backend: "macos-keychain",
    });
    assert.equal((await getMailProfileStatus("student", { configDir, store })).credentialAvailable, true);
    assert.equal((await deleteStoredMailCredentials("student", { configDir, store })).removed, true);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("mail MIME parsing prefers text and removes terminal controls", async () => {
  const source = Buffer.from([
    "From: =?UTF-8?B?5ZGo6K+V?= <sender@example.com>",
    "Subject: =?UTF-8?B?5rWL6K+V?=",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello</p><script>alert(1)</script> <b>world</b>\u001b[31m!",
  ].join("\r\n"));
  const parsed = await parseMailSource(source);
  assert.equal(parsed.textBody, "Hello\n\nworld!");
  assert.equal(parsed.truncated, false);
});

test("mail client uses UID search, BODY.PEEK source reads, and UIDVALIDITY", async () => {
  const calls: string[] = [];
  const source = Buffer.from([
    "From: sender@example.com",
    "To: student@example.com",
    "Subject: Fixture",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Unread body",
  ].join("\r\n"));
  const credentials: MailCredentials = { email: "student@example.com", password: "secret", profile: "default", source: "system-keyring" };
  const fake = {
    isClosed: false,
    usable: true,
    mailbox: { uidValidity: 42n },
    async connect() { calls.push("connect"); },
    async logout() { calls.push("logout"); },
    close() { calls.push("close"); },
    async list() { return [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", status: { unseen: 1 } }]; },
    async getMailboxLock(path: string) { calls.push(`lock:${path}`); return { release() { calls.push("release"); } }; },
    async search(criteria: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push(`search:${String(criteria.seen)}:${String(options.uid)}`);
      return [7];
    },
    async fetchAll() {
      return [{ uid: 7, envelope: { subject: "Fixture", from: [{ address: "sender@example.com" }], to: [{ address: "student@example.com" }] }, flags: new Set<string>(), size: source.length, bodyStructure: { type: "text" } }];
    },
    async fetchOne(uid: number, query: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push(`fetch:${uid}:${JSON.stringify(query.source)}:${String(options.uid)}`);
      return { uid, envelope: { subject: "Fixture", from: [{ address: "sender@example.com" }], to: [{ address: "student@example.com" }] }, flags: new Set<string>(), size: source.length, source, bodyStructure: { type: "text" } };
    },
  } as unknown as ImapFlow;
  const client = new MailClient({ clientFactory: () => fake });
  const results = await client.search(credentials, { unread: true, includeBody: true, limit: 1 });
  assert.equal(results[0]?.uid, 7);
  const first = results[0];
  assert.ok(first && "textBody" in first);
  assert.equal(first.textBody, "Unread body");
  assert.match(calls.join("\n"), /search:false:true/u);
  assert.match(calls.join("\n"), /fetch:7:\{"start":0,"maxLength":65536\}:true/u);
  assert.ok(calls.includes("release"));
  const message = await client.read(credentials, { folder: "INBOX", uid: 7, uidValidity: "42" });
  assert.equal(message.uidValidity, "42");
});
