import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = join(process.cwd(), ".env");

if (existsSync(envFile)) {
  loadEnvFile();
}

const dataDirectory = join(process.cwd(), "data");

mkdirSync(dataDirectory, { recursive: true });

const adminUsername = process.env.APP_ADMIN_USERNAME ?? "";
const adminPassword = process.env.APP_ADMIN_PASSWORD ?? "";

export const config = Object.freeze({
  port: Number(process.env.PORT ?? 3000),
  toolCallModel: process.env.TOOL_CALL_MODEL ?? "",
  dataFile: join(dataDirectory, "app.json"),
  sessionCookieName: "ds_reverse_session",
  sessionTtlMs: 1000 * 60 * 60 * 24 * 7,
  requestBodyLimitBytes: 110 * 1024 * 1024,
  deepseekBaseUrl: "https://chat.deepseek.com",
  powWasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm",
  powProtectedPaths: new Set([
    "/api/v0/chat/completion",
    "/api/v0/file/upload_file"
  ]),
  allowedProxyPaths: new Set([
    "/api/v0/chat/completion",
    "/api/v0/chat/continue",
    "/api/v0/chat/create_pow_challenge",
    "/api/v0/chat/edit_message",
    "/api/v0/chat/history_messages",
    "/api/v0/chat/message_feedback",
    "/api/v0/chat/regenerate",
    "/api/v0/chat/resume_stream",
    "/api/v0/chat/stop_stream",
    "/api/v0/chat_session/create",
    "/api/v0/chat_session/delete",
    "/api/v0/chat_session/delete_all",
    "/api/v0/chat_session/fetch_page",
    "/api/v0/chat_session/update_pinned",
    "/api/v0/chat_session/update_title",
    "/api/v0/client/settings",
    "/api/v0/download_export_history",
    "/api/v0/export_all",
    "/api/v0/file/fetch_files",
    "/api/v0/file/preview",
    "/api/v0/file/upload_file",
    "/api/v0/share/content",
    "/api/v0/share/create",
    "/api/v0/share/delete",
    "/api/v0/share/fork",
    "/api/v0/share/list",
    "/api/v0/users",
    "/api/v0/users/settings",
    "/api/v0/users/update_settings"
  ]),
  deepseekHeaders: Object.freeze({
    appVersion: "20241129.1",
    clientVersion: "1.8.0",
    clientPlatform: "web",
    locale: "zh_CN",
    timezoneOffset: "28800"
  }),
  admin: Object.freeze({
    enabled: Boolean(adminUsername && adminPassword),
    username: adminUsername,
    password: adminPassword
  })
});
