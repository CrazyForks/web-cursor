/**
 * [INPUT]: strict browser preview ToolResult + locale
 * [OUTPUT]: deterministic user-role feedback text for the next AgentRun model round
 * [POS]: A 域 preview→agent transcript adapter
 * [PROTOCOL]: only fields admitted by ToolResultSchema are rendered; no error fields are inferred
 */
import type { AppLocale } from "@/i18n/locales";
import type { ChatTurn } from "@/types/chat";
import { ToolResultType } from "@/types/tool";

export function previewFeedbackMessage(
  result: Extract<ChatTurn, { kind: "preview_feedback" }>["result"],
  locale: AppLocale,
): string {
  if (locale === "en") {
    if (result.status === "ok") {
      return [
        `Browser preview result: ${result.type}${result.durationMs ? `, ${result.durationMs}ms` : ""}.`,
        `WebContainer dev server: ${result.url} (port ${result.port}).`,
        result.rawLog ? `Raw npm dev output:\n${result.rawLog}` : "",
      ].filter(Boolean).join("\n");
    }

    if (
      result.type === ToolResultType.InstallError
      || result.type === ToolResultType.DevServerError
    ) {
      return [
        `Browser preview failed: ${result.type}`,
        `Command: ${result.command}`,
        `Exit code: ${result.exitCode ?? "not exited"}`,
        `Error message: ${result.message}`,
        `Raw command output:\n${result.rawLog}`,
        "Continue fixing the project files based on this real npm/Rsbuild output; do not assume the project is already running.",
      ].join("\n");
    }

    return [
      `Browser preview failed: ${result.type}`,
      `Error message: ${result.message}`,
      result.type === ToolResultType.BrowserRuntimeError && result.stack
        ? `Stack trace: ${result.stack}`
        : "",
      result.type === ToolResultType.BrowserRuntimeError && result.rawLog
        ? `Raw npm dev output:\n${result.rawLog}`
        : "",
      "Continue fixing the project files based on this real preview result; do not assume the project is already running.",
    ].filter(Boolean).join("\n");
  }

  if (result.status === "ok") {
    return [
      `浏览器预览结果：${result.type}${result.durationMs ? `，耗时 ${result.durationMs}ms` : ""}。`,
      `WebContainer dev server：${result.url}（端口 ${result.port}）。`,
      result.rawLog ? `npm dev 原始输出：\n${result.rawLog}` : "",
    ].filter(Boolean).join("\n");
  }

  if (
    result.type === ToolResultType.InstallError
    || result.type === ToolResultType.DevServerError
  ) {
    return [
      `浏览器预览失败：${result.type}`,
      `执行命令：${result.command}`,
      `退出码：${result.exitCode ?? "进程未退出"}`,
      `错误信息：${result.message}`,
      `原始命令输出：\n${result.rawLog}`,
      "请根据这个真实 npm/Rsbuild 输出继续修复项目文件；不要假设项目已经能运行。",
    ].join("\n");
  }

  return [
    `浏览器预览失败：${result.type}`,
    `错误信息：${result.message}`,
    result.type === ToolResultType.BrowserRuntimeError && result.stack
      ? `错误堆栈：${result.stack}`
      : "",
    result.type === ToolResultType.BrowserRuntimeError && result.rawLog
      ? `npm dev 原始输出：\n${result.rawLog}`
      : "",
    "请根据这个真实预览结果继续修复项目文件；不要假设项目已经能运行。",
  ].filter(Boolean).join("\n");
}
