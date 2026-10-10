# SUSTech 邮箱只读能力设计

- **状态**：Draft
- **目标版本**：`sustech-cli` 后续版本
- **适用仓库**：本地 `sustech-cli`
- **外部配置依据**：[南科手册：电子邮件服务](https://sustech.online/service/email/)

## 1. 问题与结论

`sustech-cli` 当前支持 TIS、Blackboard、预约、图书馆等服务，但没有真实邮箱服务。Blackboard 站内消息已经由 `bb message-folders`、`bb messages` 和 `bb message-participants` 覆盖；本文设计的是南科大真实邮箱，而不是 Blackboard 站内消息。

结论：增加邮箱只读能力可行，但应作为独立的 `mail` 服务实现，不应复用 Blackboard CAS 会话或把邮箱伪装成现有 HTTP `ServiceAdapter`。邮箱使用独立的 IMAP over TLS 连接、独立的凭证存储命名空间和独立的命令组。

第一版不实现网页抓取、发信、回复、转发、删除、移动、标记已读或附件下载。

## 2. 已确认的邮箱配置

南科手册说明学校使用腾讯企业邮箱。示例学生邮箱为 `12010100@mail.sustech.edu.cn`；教职员通常使用 `@sustech.edu.cn`，学生通常使用 `@mail.sustech.edu.cn`。

| 项目 | 配置 |
| --- | --- |
| Web 邮箱 | `https://exmail.qq.com/login` |
| 南科大邮箱入口 | `https://mail.sustech.edu.cn/` |
| CAS 登录 | `https://mail.sustech.edu.cn/sso?lang=zh` |
| 用户名 | 完整邮箱地址，例如 `12010100@mail.sustech.edu.cn` |
| Exchange | `ex.exmail.qq.com` |
| SMTP over SSL | `smtp.exmail.qq.com:465` |
| POP3 over SSL | `pop.exmail.qq.com:995` |
| IMAP over SSL | `imap.exmail.qq.com:993` |

邮箱读取选择 IMAP，而不是 POP3：IMAP 支持文件夹、服务端搜索、未读状态、UID 和 `BODY.PEEK`，适合受控的增量读取。SMTP 和 Exchange 不属于第一版范围。

账号密码表中的 `sustech-manual` 只是网页示例值，不是实现配置，也不能写入测试、文档示例配置或日志。

### 2.1 IMAP 服务开通条件（腾讯官方文档已确认）

根据[企业微信帮助中心：客户端协议设置](https://open.work.weixin.qq.com/help2/pc/19886)，IMAP 登录需要两级开关同时打开：

1. **管理员侧**：企业微信管理端「协作 → 邮件 → 安全管理 → 应用访问权限」中，IMAP/SMTP 服务范围必须包含该成员；未配置范围时成员无法自行开启；
2. **成员侧**：网页登录邮箱后，「设置 → 收发信设置 → 开启服务」中勾选 IMAP/SMTP 服务。

密码规则：默认使用邮箱密码；若账号开启了「安全登录」，必须在网页端「设置 → 邮箱绑定」中获取**客户端授权码**，客户端登录时以授权码代替密码。CLI 不区分两者，统一按 `password` 字段处理，由用户在 `mail auth login` 时输入正确的值。

另外两个影响读取行为的网页端设置：

- 「设置 → 收发信设置」中的**收取范围**默认可能只同步最近 30 天的邮件，需改为「全部」才能搜到更早的邮件；
- 「文件夹锁定区」或「同步到我的文件夹」设置会影响自定义文件夹的 IMAP 可见性。

## 3. 目标

提供结构化、可脚本化、默认只读的命令：

```text
sustech mail auth login
sustech mail auth status
sustech mail auth logout
sustech mail folders
sustech mail search
sustech mail read
```

机器可读输出继续使用现有版本化 envelope：

```json
{
  "schemaVersion": "1",
  "ok": true,
  "command": "mail search",
  "data": {}
}
```

## 4. 非目标

第一版明确不做：

- SMTP 发信；
- 自动回复或转发；
- 删除、移动、归档或标记已读；
- POP3 读取；
- Exchange ActiveSync；
- 网页邮箱 HTML 抓取；
- 自动处理 CAPTCHA 或绕过登录挑战；
- 自动下载或解析附件；
- 任意 IMAP 命令执行；
- 公共 MCP 直接暴露个人邮箱正文；
- 将邮件正文持久化到本地缓存。

## 5. 总体架构

```text
mail auth login
        ↓
操作系统密钥环 / 加密凭证文件
        ↓
mail client（IMAP over TLS）
        ↓
搜索、UID 读取、MIME 解析、正文裁剪
        ↓
typed mail result
        ↓
CLI text / JSON / JSONL
```

遵循现有架构约束：服务模块返回 typed value，不直接打印；`src/cli.ts` 负责参数校验、命令路由和输出选择；输出层负责 text、JSON 和 JSONL。

邮箱协议是原始 TCP/TLS 协议，不适合直接套用 `src/services/base.ts` 的 HTTP `ServiceAdapter`。建议新增独立的 `src/mail/` 模块，必要时复用其中的错误、文本清理和分页类型，而不是扩展 HTTP adapter 以承载 IMAP。

建议使用成熟的 Node.js IMAP 客户端库，例如 `imapflow`，避免手写 IMAP 命令解析、续行响应、字面量和 TLS 状态机。

## 6. 邮箱认证与凭证

### 6.1 独立凭证模型

现有 `src/core/credentials.ts` 的 `Credentials` 是 SUSTech SID/password 模型，服务于 CAS、TIS、Blackboard 等系统。邮箱使用不同的账号形态，应新增独立类型：

```typescript
export interface MailCredentials {
  email: string;
  password: string;
  profile: string;
  source: CredentialSource;
}
```

邮箱密码是邮箱密码或腾讯「安全登录」要求的客户端授权码（见 §2.1）。CLI 不应假设它等于 CAS 密码，也不应自动尝试多个密码。CAS 绑定只影响网页登录入口（首次 CAS 登录时绑定邮箱账号），不改变 IMAP 登录所需的密码或账号格式。

### 6.2 密钥环命名空间

当前 `src/core/keyring.ts` 已将 CAS 凭证和 Blackboard 日历链接分成不同命名空间。邮箱新增独立命名空间，例如：

```text
cn.edu.sustech.cli.mail
```

邮箱 profile 元数据至少包含：

```json
{
  "profile": "default",
  "email": "12010100@mail.sustech.edu.cn",
  "backend": "linux-encrypted-file",
  "storedAt": "..."
}
```

密码只进入操作系统密钥环或现有 AES-256-GCM 加密文件后端，不进入普通配置文件。

邮箱命令可以复用 `SUSTECH_MASTER_PASSWORD` 解锁现有 Linux 加密存储，但必须使用邮箱独立的 secret namespace。不能复用 CAS secret 的 account key，也不能把邮箱密码放入 `SUSTECH_PASSWORD`。

### 6.3 登录命令

建议命令：

```bash
sustech mail auth login --email 12010100@mail.sustech.edu.cn
```

密码只能来自隐藏交互提示或：

```bash
printf '%s\n' "$MAIL_PASSWORD" | sustech mail auth login \
  --email 12010100@mail.sustech.edu.cn \
  --password-stdin
```

不允许：

```bash
sustech mail auth login --email user@mail.sustech.edu.cn --password '...'
```

登录流程：

1. 校验完整邮箱地址格式；
2. 使用 IMAPS `imap.exmail.qq.com:993` 建立 TLS 连接；
3. 使用 `LOGIN` 或库提供的等价安全认证流程验证账号；
4. 成功后将密码写入独立 secret namespace；
5. 立即读回验证密钥环写入；
6. 输出脱敏账号和后端状态，不输出密码。

客户端授权码与邮箱密码在协议层同为密码字段（`AUTH=PLAIN`/`AUTH=LOGIN`），无需区分处理；如果腾讯企业邮箱后续引入 OAuth 等其他认证方式，认证实现应通过 `MailAuthProvider` 扩展，不改变命令层和结果模型。

### 6.4 传输与进程保护

TLS 基线：

- 只使用 `imap.exmail.qq.com:993` 的隐式 TLS，不使用明文 + STARTTLS，避免降级；
- 强制证书链与主机名校验，不提供跳过校验的选项；
- 最低 TLS 1.2，依赖库默认值之外的降级配置不允许。

进程保护：

- 邮箱密码只经隐藏提示或 stdin 进入进程；进程 argv、环境变量、日志、崩溃堆栈和错误详情中都不得出现密码或授权码；
- 认证完成后立即丢弃明文密码引用，不存入结果对象或模块级缓存；
- 认证失败不自动重试：腾讯企业邮箱对连续失败可能触发账号锁定，CLI 失败一次即返回 `MAIL_AUTH_FAILED`，由用户显式重试；
- 每条命令建立独立 IMAP 连接，命令结束（含出错路径）必须 `LOGOUT` 或关闭连接，不留下后台悬挂连接。

## 7. CLI 命令设计

### 7.1 `mail auth status`

只读取 profile 元数据和密钥环可用性；默认不连接邮箱，不显示密码。

```bash
sustech mail auth status --json
```

### 7.2 `mail folders`

列出可访问的邮箱文件夹，返回显示名、IMAP 名称和未读数量（如果服务器提供）。

```bash
sustech mail folders
```

文件夹发现不硬编码英文名称：腾讯企业邮箱的实际文件夹名可能是本地化名称（如「已发送」），应通过 IMAP `SPECIAL-USE` 属性（`\Inbox`、`\Sent`、`\Trash`、`\Junk`、`\Drafts`）识别语义文件夹，识别失败时回退到服务器返回的原始名称。

`--folder` 只接受 `mail folders` 返回过的文件夹名。不得允许用户通过任意字符串构造危险的 IMAP 命令。文件夹名必须作为 IMAP 参数编码，由客户端库负责 quoting。

### 7.3 `mail search`

只允许结构化过滤器：

```bash
sustech mail search \
  --folder INBOX \
  --unread \
  --from office@sustech.edu.cn \
  --subject 奖学金 \
  --since 2026-10-01 \
  --until 2026-10-10 \
  --limit 10
```

建议选项：

| 选项 | 默认值 | 限制 |
| --- | --- | --- |
| `--folder` | `INBOX` | 必须是已选文件夹或安全的 IMAP folder name |
| `--unread` | `false` | 使用 `UNSEEN` |
| `--from` | 空 | 最多 320 字符，不能传原始 IMAP query |
| `--to` | 空 | 最多 320 字符 |
| `--subject` | 空 | 最多 200 字符 |
| `--since` | 空 | `YYYY-MM-DD` |
| `--until` | 空 | `YYYY-MM-DD` |
| `--limit` | `20` | `1..50` |
| `--include-body` | `false` | 每封正文单独受长度限制 |

搜索必须使用服务端过滤，并按 UID 或日期倒序读取。不能把用户输入拼接成任意 IMAP `SEARCH` 字符串。IMAP `SINCE`/`UNTIL` 是日期粒度且按服务器时区解释，`--since`/`--until` 的语义应明确为「服务器日期边界」，不做更细粒度的时间过滤承诺。

默认只返回邮件元数据：

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

读取指定邮件正文，不修改远端状态：

```bash
sustech mail read \
  --folder INBOX \
  --uid 1234
```

读取必须使用 `BODY.PEEK[]` 或库的等价选项。返回：

```typescript
interface MailMessage extends MailSummary {
  textBody: string;
  truncated: boolean;
  attachmentNames: string[];
}
```

`uidValidity` 应随搜索结果返回，并在读取时校验。邮箱文件夹重建后 UID 可能复用，不能只把裸 UID 当作永久消息 ID。

### 7.5 `mail search --include-body`

为了支持一次性读取多封邮件正文（例如批量导出或摘要场景），`mail search` 可以提供 `--include-body`，内部执行：

1. 服务端搜索；
2. 限制 UID 数量；
3. 批量读取邮件头和正文；
4. MIME 解码；
5. 返回受限正文。

调用方只应传递已校验的结构化参数；CLI 负责硬限制，不暴露任意 IMAP 命令拼接能力。

## 8. MIME 与正文处理

邮件正文读取规则：

1. 优先使用 `text/plain`；
2. 没有纯文本时解析 `text/html`；
3. HTML 只保留文本，不执行脚本、不加载远程资源、不访问图片 URL；
4. 正确处理 MIME transfer encoding 和常见字符集；
5. 标题、发件人和收件人使用 RFC 2047 解码；
6. 规范化换行和空白；
7. 附件只返回名称、MIME 类型和大小，不读取二进制内容；
8. 过滤控制字符，但不擅自修改正文语义；
9. 所有服务器可控字符串（标题、发件人、文件夹名、附件名、正文）在进入 text 输出前统一过滤 ANSI 转义序列和控制字符，防止终端注入；JSON 输出保留原文但同样去除 C0/C1 控制字符；
10. 正文使用 IMAP 部分获取（`BODY.PEEK[]<0.上限>`）在协议层限制下载字节数，超限标记 `truncated: true`；不下载完整邮件后再在内存中裁剪，避免超大邮件耗尽内存。

建议硬限制：

```text
单次最多 20 封
单封正文最多 20,000 字符
单次返回正文最多 200,000 字符
单封附件元数据最多 50 项
IMAP 单次请求超时 30 秒
CLI 总命令超时沿用现有上限
```

超限时返回 `truncated: true`，不能静默假装内容完整。

## 9. 错误模型

新增稳定错误码，至少包括：

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

错误输出不得包含：

- 邮箱密码；
- AUTH 命令原文；
- 原始服务器响应中的 token；
- 完整邮件正文；
- 可能包含敏感信息的服务器调试响应。

错误详情可以保留安全字段，例如服务名、主机名、阶段、超时和脱敏状态码。

## 10. `services status` 与能力注册

新增：

```text
mail
```

`src/services/base.ts` 当前的 `ServiceAuthMode` 只有 HTTP/cookie/bearer/browser 类型。邮箱应增加明确模式，例如：

```typescript
export type ServiceAuthMode =
  | "none"
  | "cookie-session"
  | "bearer-header"
  | "browser"
  | "imap-tls";
```

服务状态建议：

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

`CAPABILITIES` 新增：

```text
mail auth status
mail folders
mail search
mail read
```

这些命令全部是 `read` 或本地 credential-management 命令，不需要 `--confirm`。

## 11. MCP 边界

当前 `src/mcp` 的设计明确拒绝已认证个人数据和本地私密状态。真实邮箱正文属于高敏感个人数据，因此第一版：

- 可以在 capability registry 中描述 `mail` 命令；
- 不加入 `src/mcp/public-tool-names.ts`；
- 不加入公共 typed MCP tool；
- `sustech_discover` 中可以显示 `mcpExecutable: false`；
- 只能由本地 CLI 直接调用。

如果未来需要 MCP 邮箱工具，必须先设计按用户绑定的认证上下文、私聊限制、结果长度限制和审计策略，不能仅仅把 `mail search` 加进公共工具白名单。

## 12. 测试设计

### 12.1 单元测试

新增邮件解析测试：

- RFC 2047 中文标题和发件人；
- `text/plain`；
- HTML fallback；
- multipart/alternative；
- 附件元数据；
- 非 UTF-8 字符集；
- 正文截断；
- 控制字符清理；
- 无日期或非法日期；
- UIDVALIDITY 变化。

### 12.2 协议 fixture

使用假的 IMAP server 或可注入 transport 测试：

- TLS 建连失败；
- 登录成功和失败；
- SELECT 文件夹；
- UNSEEN 搜索；
- FROM/SUBJECT/日期过滤；
- BODY.PEEK 读取；
- 分段响应；
- 超时；
- 超大响应；
- 服务端 BYE；
- 无效 MIME。

测试不能连接真实邮箱，也不能把真实邮件内容写进仓库。

### 12.3 CLI 合约测试

验证：

- `--help` 包含 mail 命令；
- `describe mail search --json` 返回正确 options；
- `capabilities --json` 返回稳定 capability；
- text、JSON、JSONL 三种输出；
- 无凭证时不建立 IMAP 连接；
- 非法参数在认证前失败；
- 密码不出现在任何输出；
- 默认 `include-body=false`；
- 返回数量和截断标记正确。

## 13. 实施顺序

### Phase 1：协议和模型

1. 选定并锁定 IMAP 客户端依赖；
2. 新增 `src/mail/types.ts` 和解析边界；
3. 用 fixture 完成 MIME 和 IMAP 协议测试。

### Phase 2：凭证和 CLI

1. 新增邮箱 keyring namespace；
2. 实现 `mail auth login/status/logout`；
3. 实现 `mail folders/search/read`；
4. 加入 capabilities、command metadata、help、text/JSON/JSONL；
5. 更新 `SERVICES.md`、`AUTHENTICATION.md` 和 README。

### Phase 3：受控验收

1. 使用专用测试邮箱；
2. 只验证读取，不验证发信；
3. 验证未读状态不会被改变；
4. 验证密码和正文不进入日志；

## 14. 验收标准

功能完成必须同时满足：

- `mail auth login` 能保存独立邮箱凭证；
- `mail auth status` 不泄露密码；
- `mail folders` 能读取邮箱文件夹；
- `mail search --unread` 能服务端过滤未读邮件；
- `mail read` 能解码中文标题和正文；
- 读取使用 `BODY.PEEK`，不会自动标记已读；
- JSON envelope 稳定且正文有硬长度上限；
- 超时、认证失败、UIDVALIDITY 变化均有稳定错误码；
- CLI 不接受任意 IMAP 命令；
- 公共 MCP 不暴露个人邮箱正文；
- 现有 CLI 测试不因新增能力回归；
- TLS 证书与主机名校验不可通过任何选项关闭；
- text 输出中不出现服务器可控的 ANSI 控制字符；
- 认证失败不自动重试，日志和崩溃输出不含密码。

---

## 参考资料

- [南科手册：电子邮件服务](https://sustech.online/service/email/)
- [腾讯企业邮箱客户端设置](https://service.exmail.qq.com/cgi-bin/help?subtype=1&id=28&no=1000585)
- [本地架构说明](./ARCHITECTURE.md)
- [本地认证说明](./AUTHENTICATION.md)
- [本地服务矩阵](./SERVICES.md)
- [本地输出契约](./OUTPUT.md)
