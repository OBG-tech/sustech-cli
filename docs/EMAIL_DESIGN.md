# Design: Read-Only SUSTech Mail Access

- **Status**: Draft
- **Target version**: A future `sustech-cli` release
- **Repository**: The local `sustech-cli` repository
- **External configuration reference**: [SUSTech manual: Email service](https://sustech.online/service/email/)

## 1. Problem and conclusion

`sustech-cli` currently supports TIS, Blackboard, bookings, library services, and other services, but it has no real email service. Blackboard internal messages are already covered by `bb message-folders`, `bb messages`, and `bb message-participants`; this document designs access to the university's real mailbox, not Blackboard internal messages.

Conclusion: read-only mailbox access is feasible, but it should be implemented as an independent `mail` service. It should not reuse the Blackboard CAS session or make the mailbox look like an existing HTTP `ServiceAdapter`. Mail uses an independent IMAP-over-TLS connection, an independent credential-storage namespace, and an independent command group.

The first version does not implement web scraping, sending, replying, forwarding, deleting, moving, marking messages as read, or downloading attachments.

## 2. Confirmed mailbox configuration

The SUSTech manual states that the university uses Tencent Enterprise Mail. An example student address is `12010100@mail.sustech.edu.cn`; faculty and staff generally use `@sustech.edu.cn`, while students generally use `@mail.sustech.edu.cn`.

| Item | Configuration |
| --- | --- |
| Web mail | `https://exmail.qq.com/login` |
| SUSTech mail portal | `https://mail.sustech.edu.cn/` |
| CAS login | `https://mail.sustech.edu.cn/sso?lang=zh` |
| Username | The full email address, for example `12010100@mail.sustech.edu.cn` |
| Exchange | `ex.exmail.qq.com` |
| SMTP over SSL | `smtp.exmail.qq.com:465` |
| POP3 over SSL | `pop.exmail.qq.com:995` |
| IMAP over SSL | `imap.exmail.qq.com:993` |

Mail access uses IMAP rather than POP3: IMAP supports folders, server-side search, unread state, UIDs, and `BODY.PEEK`, making it suitable for controlled incremental reads. SMTP and Exchange are out of scope for the first version.

The `sustech-manual` value in the account-password table is only a web-page example. It is not an implementation setting and must not appear in test data, documentation configuration examples, or logs.

### 2.1 IMAP service activation requirements (confirmed by Tencent documentation)

According to [WeCom Help Center: Client protocol settings](https://open.work.weixin.qq.com/help2/pc/19886), IMAP access requires two switches to be enabled:

1. **Administrator side**: In the WeCom admin console, under `Collaboration → Mail → Security management → Application access permissions`, the IMAP/SMTP service scope must include the member. If no scope is configured, the member cannot enable the service independently.
2. **Member side**: After logging in to web mail, enable IMAP/SMTP under `Settings → Send and receive settings → Enable services`.

Password rules: the mailbox password is used by default. If the account has **Secure Login** enabled, the user must obtain a **client authorization code** from `Settings → Mail binding` in the web interface and use that code instead of the password for client login. The CLI treats both values uniformly as the `password` field; the user supplies the correct value during `mail auth login`.

Two other web-mail settings affect read behavior:

- The **mail collection range** under `Settings → Send and receive settings` may default to synchronizing only the most recent 30 days. It must be changed to **All** to search older messages.
- **Folder lock area** or **Sync to my folders** settings affect whether custom folders are visible through IMAP.

## 3. Goals

Provide structured, scriptable, read-only-by-default commands:

```text
sustech mail auth login
sustech mail auth status
sustech mail auth logout
sustech mail folders
sustech mail search
sustech mail read
```

Machine-readable output continues to use the existing versioned envelope:

```json
{
  "schemaVersion": "1",
  "ok": true,
  "command": "mail search",
  "data": {}
}
```

## 4. Non-goals

The first version explicitly does not include:

- SMTP sending;
- automatic replies or forwarding;
- deleting, moving, archiving, or marking messages as read;
- POP3 access;
- Exchange ActiveSync;
- HTML scraping of web mail;
- automatic CAPTCHA handling or bypassing login challenges;
- automatic attachment downloads or parsing;
- arbitrary IMAP command execution;
- exposing personal mailbox content directly through public MCP;
- persisting message bodies in a local cache.

## 5. Overall architecture

```text
mail auth login
        ↓
OS keychain / encrypted credential file
        ↓
mail client (IMAP over TLS)
        ↓
search, UID reads, MIME parsing, body truncation
        ↓
typed mail result
        ↓
CLI text / JSON / JSONL
```

Follow the existing architectural constraints: service modules return typed values and do not print directly; `src/cli.ts` handles argument validation, command routing, and output selection; the output layer handles text, JSON, and JSONL.

Mail is a raw TCP/TLS protocol and should not be forced into the HTTP `ServiceAdapter` defined in `src/services/base.ts`. Add an independent `src/mail/` module instead. Reuse error, text-cleaning, and pagination types where appropriate rather than extending the HTTP adapter to carry IMAP.

Use a mature Node.js IMAP client library such as `imapflow` to avoid implementing IMAP command parsing, continuation responses, literals, and the TLS state machine by hand.

## 6. Mail authentication and credentials

### 6.1 Independent credential model

The existing `Credentials` type in `src/core/credentials.ts` models SUSTech SID/password credentials for CAS, TIS, Blackboard, and other systems. Mail uses a different account shape and should have an independent type:

```typescript
export interface MailCredentials {
  email: string;
  password: string;
  profile: string;
  source: CredentialSource;
}
```

The mailbox password is either the mailbox password or the client authorization code required by Tencent **Secure Login** (see §2.1). The CLI must not assume that it equals the CAS password or automatically try multiple passwords. CAS binding affects only the web-mail entry point (the first CAS login binds the mailbox account); it does not change the password or account format required for IMAP login.

### 6.2 Keychain namespace

`src/core/keyring.ts` already separates CAS credentials and Blackboard calendar links into different namespaces. Mail adds an independent namespace, for example:

```text
cn.edu.sustech.cli.mail
```

Mail profile metadata must contain at least:

```json
{
  "profile": "default",
  "email": "12010100@mail.sustech.edu.cn",
  "backend": "linux-encrypted-file",
  "storedAt": "..."
}
```

The password enters only the operating-system keychain or the existing AES-256-GCM encrypted-file backend; it must not enter an ordinary configuration file.

Mail commands may reuse `SUSTECH_MASTER_PASSWORD` to unlock the existing Linux encrypted store, but they must use the independent mail secret namespace. They must not reuse the CAS secret account key or put the mailbox password in `SUSTECH_PASSWORD`.

### 6.3 Login command

Recommended command:

```bash
sustech mail auth login --email 12010100@mail.sustech.edu.cn
```

The password may come only from a hidden interactive prompt or from stdin:

```bash
printf '%s\n' "$MAIL_PASSWORD" | sustech mail auth login \
  --email 12010100@mail.sustech.edu.cn \
  --password-stdin
```

Not allowed:

```bash
sustech mail auth login --email user@mail.sustech.edu.cn --password '...'
```

Login flow:

1. Validate the full email address format;
2. Establish a TLS connection to `imap.exmail.qq.com:993` using IMAPS;
3. Verify the account with `LOGIN` or the equivalent secure authentication flow provided by the library;
4. Write the password to the independent secret namespace after success;
5. Read it back immediately to verify the keychain write;
6. Output a masked account and backend status without outputting the password.

At the protocol layer, a client authorization code and a mailbox password are both password fields (`AUTH=PLAIN`/`AUTH=LOGIN`) and do not need separate handling. If Tencent Enterprise Mail later introduces another authentication method such as OAuth, extend the authentication implementation through `MailAuthProvider` without changing the command layer or result model.

### 6.4 Transport and process protection

TLS baseline:

- Use only implicit TLS on `imap.exmail.qq.com:993`; do not use plaintext plus STARTTLS, which could permit downgrade;
- enforce certificate-chain and hostname verification; do not provide an option to skip verification;
- require TLS 1.2 or newer; do not allow downgrade configuration beyond the library defaults.

Process protection:

- The mailbox password may enter the process only through a hidden prompt or stdin; it must not appear in process arguments, environment variables, logs, crash stacks, or error details;
- discard the plaintext password reference immediately after authentication; do not store it in result objects or module-level caches;
- do not retry authentication failures automatically: Tencent Enterprise Mail may lock an account after repeated failures, so the CLI returns `MAIL_AUTH_FAILED` after one failure and leaves retries to the user;
- establish an independent IMAP connection for every command and `LOGOUT` or close it on every exit path, including errors, without leaving background connections.

## 7. CLI command design

### 7.1 `mail auth status`

Read only profile metadata and keychain availability. Do not connect to the mailbox or display the password by default.

```bash
sustech mail auth status --json
```

### 7.2 `mail folders`

List accessible mailbox folders and return the display name, IMAP name, and unread count when provided by the server.

```bash
sustech mail folders
```

Folder discovery must not hard-code English names: Tencent Enterprise Mail may return localized folder names such as `Sent`. Identify semantic folders through the IMAP `SPECIAL-USE` attributes (`\Inbox`, `\Sent`, `\Trash`, `\Junk`, `\Drafts`) and fall back to the raw server name when semantic identification fails.

`--folder` accepts only folder names returned by `mail folders`. Do not allow arbitrary strings to construct dangerous IMAP commands. The folder name must be encoded as an IMAP argument by the client library.

### 7.3 `mail search`

Allow only structured filters:

```bash
sustech mail search \
  --folder INBOX \
  --unread \
  --from office@sustech.edu.cn \
  --subject scholarship \
  --since 2026-10-01 \
  --until 2026-10-10 \
  --limit 10
```

Recommended options:

| Option | Default | Limit |
| --- | --- | --- |
| `--folder` | `INBOX` | Must be a selected folder or a safe IMAP folder name |
| `--unread` | `false` | Uses `UNSEEN` |
| `--from` | Empty | At most 320 characters; raw IMAP queries are not allowed |
| `--to` | Empty | At most 320 characters |
| `--subject` | Empty | At most 200 characters |
| `--since` | Empty | `YYYY-MM-DD` |
| `--until` | Empty | `YYYY-MM-DD` |
| `--limit` | `20` | `1..50` |
| `--include-body` | `false` | Each message body is subject to its own length limit |

Search must use server-side filters and read results in descending UID or date order. Do not concatenate user input into an arbitrary IMAP `SEARCH` string. IMAP `SINCE`/`UNTIL` operate at date granularity and use the server timezone; document `--since`/`--until` as server-date boundaries and do not promise finer-grained time filtering.

By default, return only message metadata:

```typescript
interface MailSummary {
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
```

### 7.4 `mail read`

Read a specified message body without changing remote state:

```bash
sustech mail read \
  --folder INBOX \
  --uid 1234
```

Reads must use `BODY.PEEK[]` or the library equivalent. Return:

```typescript
interface MailMessage extends MailSummary {
  textBody: string;
  truncated: boolean;
  attachmentNames: string[];
}
```

Return `uidValidity` with search results and validate it during reads. A folder rebuild can reuse UIDs, so a bare UID must not be treated as a permanent message ID.

### 7.5 `mail search --include-body`

To support reading several message bodies in one operation, for example for batch export or summarization, `mail search` may accept `--include-body` and perform:

1. Server-side search;
2. UID-count limiting;
3. Batch header and body reads;
4. MIME decoding;
5. Return of bounded message bodies.

Callers should pass only validated structured parameters. The CLI enforces hard limits and does not expose arbitrary IMAP command construction.

## 8. MIME and body handling

Message-body rules:

1. Prefer `text/plain`;
2. Parse `text/html` when plain text is unavailable;
3. Keep only text from HTML; do not execute scripts, load remote resources, or access image URLs;
4. Correctly handle MIME transfer encoding and common character sets;
5. Decode subjects, senders, and recipients using RFC 2047;
6. Normalize line endings and whitespace;
7. Return attachment names, MIME types, and sizes only; do not read binary contents;
8. Filter control characters without changing the meaning of the body;
9. Before server-controlled strings (subjects, senders, recipients, folder names, attachment names, and bodies) enter text output, uniformly filter ANSI escape sequences and control characters to prevent terminal injection. JSON output preserves the remaining text while also removing C0/C1 control characters;
10. Use IMAP partial fetch (`BODY.PEEK[]<0.limit>`) to limit downloaded bytes at the protocol layer and set `truncated: true` when the limit is exceeded. Do not download the complete message and trim it in memory, which could allow oversized messages to exhaust memory.

Recommended hard limits:

```text
At most 20 messages per operation
At most 20,000 characters per message body
At most 200,000 body characters per operation
At most 50 attachment metadata entries per message
30-second timeout for each IMAP request
Use the existing overall CLI command timeout
```

When a limit is exceeded, return `truncated: true`; never silently claim that the content is complete.

## 9. Error model

Add stable error codes including at least:

```text
MAIL_CREDENTIALS_REQUIRED
MAIL_CREDENTIALS_INVALID
MAIL_PROFILE_NOT_FOUND
MAIL_AUTH_FAILED
MAIL_IMAP_UNAVAILABLE
MAIL_TLS_ERROR
MAIL_FOLDER_NOT_FOUND
MAIL_MESSAGE_NOT_FOUND
MAIL_UID_VALIDITY_CHANGED
MAIL_RESPONSE_TOO_LARGE
MAIL_MESSAGE_PARSE_FAILED
MAIL_SEARCH_INVALID
MAIL_READ_TIMEOUT
```

Error output must not contain:

- the mailbox password;
- the raw AUTH command;
- tokens from the raw server response;
- the complete message body;
- server debug responses that may contain sensitive information.

Error details may retain safe fields such as service name, hostname, operation phase, timeout, and masked status codes.

## 10. `services status` and capability registration

Add:

```text
mail
```

The current `ServiceAuthMode` in `src/services/base.ts` contains only HTTP/cookie/bearer/browser types. Mail should add an explicit mode, for example:

```typescript
export type ServiceAuthMode =
  | "none"
  | "cookie-session"
  | "bearer-header"
  | "browser"
  | "imap-tls";
```

Suggested service status:

```typescript
export const MAIL_STATUS: ServiceStatus = {
  service: "mail",
  availability: "implemented",
  auth: "imap-tls",
  campusNetwork: false,
  browser: false,
  summary: "Read-only SUSTech enterprise-mail access through IMAPS.",
  notes: [
    "Credentials are stored in a separate operating-system credential namespace.",
    "The first version never sends, deletes, moves, or marks messages as read.",
  ],
  endpoints: ["imap.exmail.qq.com:993"],
};
```

Add to `CAPABILITIES`:

```text
mail auth status
mail folders
mail search
mail read
```

All of these commands are read-only or local credential-management commands and do not require `--confirm`.

## 11. MCP boundary

The current `src/mcp` design explicitly rejects authenticated personal data and local private state. Real mailbox content is highly sensitive personal data, so the first version:

- may describe `mail` commands in the capability registry;
- must not add them to `src/mcp/public-tool-names.ts`;
- must not add a public typed MCP tool;
- may show `mcpExecutable: false` in `sustech_discover`;
- may be invoked only directly by the local CLI.

If MCP mailbox tools are needed in the future, first design user-bound authentication context, private-conversation restrictions, result-length limits, and auditing. Do not merely add `mail search` to the public tool allowlist.

## 12. Test design

### 12.1 Unit tests

Add mail parsing tests for:

- RFC 2047 Chinese subjects and senders;
- `text/plain`;
- HTML fallback;
- multipart/alternative;
- attachment metadata;
- non-UTF-8 character sets;
- body truncation;
- control-character cleaning;
- missing or invalid dates;
- UIDVALIDITY changes.

### 12.2 Protocol fixtures

Use a fake IMAP server or injectable transport to test:

- TLS connection failure;
- successful and failed login;
- folder selection;
- `UNSEEN` search;
- FROM/SUBJECT/date filters;
- `BODY.PEEK` reads;
- segmented responses;
- timeouts;
- oversized responses;
- server BYE;
- invalid MIME.

Tests must not connect to a real mailbox or write real message content to the repository.

### 12.3 CLI contract tests

Verify:

- `--help` contains the mail commands;
- `describe mail search --json` returns the correct options;
- `capabilities --json` returns stable capabilities;
- text, JSON, and JSONL output;
- no IMAP connection is created without credentials;
- invalid arguments fail before authentication;
- passwords do not appear in any output;
- the default is `include-body=false`;
- result counts and truncation flags are correct.

## 13. Implementation order

### Phase 1: Protocol and model

1. Select and pin the IMAP client dependency;
2. Add `src/mail/types.ts` and parsing boundaries;
3. Complete MIME and IMAP protocol tests with fixtures.

### Phase 2: Credentials and CLI

1. Add the mail keychain namespace;
2. Implement `mail auth login/status/logout`;
3. Implement `mail folders/search/read`;
4. Add capabilities, command metadata, help, and text/JSON/JSONL output;
5. Update `SERVICES.md`, `AUTHENTICATION.md`, and the README.

### Phase 3: Controlled acceptance

1. Use a dedicated test mailbox;
2. Verify reads only, not sending;
3. Verify that unread state is not changed;
4. Verify that passwords and message bodies do not enter logs.

## 14. Acceptance criteria

The feature is complete only when all of the following hold:

- `mail auth login` stores an independent mailbox credential;
- `mail auth status` does not leak the password;
- `mail folders` reads mailbox folders;
- `mail search --unread` filters unread messages server-side;
- `mail read` decodes Chinese subjects and message bodies;
- reads use `BODY.PEEK` and do not automatically mark messages as read;
- the JSON envelope is stable and message bodies have hard size limits;
- timeouts, authentication failures, and UIDVALIDITY changes use stable error codes;
- the CLI does not accept arbitrary IMAP commands;
- public MCP does not expose personal mailbox content;
- existing CLI tests do not regress because of the new capability;
- TLS certificate and hostname verification cannot be disabled through any option;
- text output contains no server-controlled ANSI control characters;
- authentication failures are not retried automatically, and logs and crash output contain no password.

---

## References

- [SUSTech manual: Email service](https://sustech.online/service/email/)
- [Tencent Enterprise Mail client settings](https://service.exmail.qq.com/cgi-bin/help?subtype=1&id=28&no=1000585)
- [Local architecture](./ARCHITECTURE.md)
- [Local authentication](./AUTHENTICATION.md)
- [Local service matrix](./SERVICES.md)
- [Local output contract](./OUTPUT.md)
