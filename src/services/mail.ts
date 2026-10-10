import type { ServiceStatus } from "./base.js";

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
