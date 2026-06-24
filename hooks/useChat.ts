/**
 * [INPUT]: 用户 prompt（send 调用）+ PreviewPanel 挂上来的 iframe ref
 * [OUTPUT]: 会话 UI 状态 + send/stop/rerun；供 page 编排、组件展示
 * [POS]: B 域编排 hook —— 串起 后端 /api/chat（chatClient）→ 转译 → 沙箱 → 自我修复
 * [PROTOCOL]: LLM 只由 /api/chat 驱动；浏览器工具结果先 POST tool-results 闭合，再用 kind=resume 续写
 *
 * 流程：send(prompt) → 流式拿后端结果
 *   - type:"code" → 灌编辑器；流完 → 转译 + 跑沙箱；成功/失败都回传 tool result 闭合 tool_call
 *   - 失败 → 再发 kind:"resume"，后端从已闭合 transcript 继续生成修复版
 *   - type:"chat" → AI 在提问/回话 → 显示文字，停下等用户
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SandboxController } from "@/lib/sandbox/controller";
import { transpile, TranspileError } from "@/lib/transpile";
import { postToolResult, streamChat } from "@/lib/chatClient";
import type { Message, Phase, Status, Overlay } from "@/lib/types";
import type { ChatTurn } from "@/types/chat";
import { ToolResultType } from "@/types/tool";

const MAX_ATTEMPTS = 4;
const EMPTY_OVERLAY: Overlay = { show: false, message: "", stack: "", showStack: false };
const RESTORE_TIMEOUT_MS = 3000;

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  meta?: unknown;
};

type StoredMeta = {
  kind?: "code" | "reply";
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

export function useChat() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sandboxRef = useRef<SandboxController | null>(null);
  const abortRef = useRef({ aborted: false });
  const curAiIdRef = useRef<string>("");
  const lastPromptRef = useRef<string>("");
  // B-shared：首条 chat 由后端懒建，init 回传后存下来；之后每轮带着，续到同一项目/会话
  const projectIdRef = useRef<string | undefined>(undefined);
  const convIdRef = useRef<string | undefined>(undefined);
  // 当前等待浏览器执行结果的 model tool_call。成功和失败都必须回传闭合。
  const pendingToolCallIdRef = useRef<string | undefined>(undefined);

  const [messages, setMessages] = useState<Message[]>([]);
  const [code, setCode] = useState("");
  const [writing, setWriting] = useState(false);
  const [projName, setProjName] = useState("未命名项目");
  const [status, setStatus] = useState<Status>({ kind: "", text: "等待生成" });
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [busy, setBusy] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | undefined>(undefined);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(undefined);
  const [lastTitleUpdate, setLastTitleUpdate] = useState<{
    conversationId: string;
    title: string;
    projectTitle?: string;
  } | null>(null);

  const ensureSandbox = useCallback(() => {
    if (iframeRef.current && !sandboxRef.current) {
      const ctl = new SandboxController(iframeRef.current);
      ctl.onLateError = (e) =>
        setOverlay({ show: true, message: e.message, stack: e.stack, showStack: false });
      sandboxRef.current = ctl;
    }
    return sandboxRef.current;
  }, []);

  useEffect(() => {
    ensureSandbox();
  });

  useEffect(() => {
    return () => sandboxRef.current?.dispose();
  }, []);

  const updateAi = useCallback(
    (fn: (m: Extract<Message, { role: "ai" }>) => Extract<Message, { role: "ai" }>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === curAiIdRef.current && m.role === "ai" ? fn(m) : m))
      );
    },
    []
  );

  const setAttempt = useCallback(
    (n: number, phase: Phase, note?: string) => {
      updateAi((m) => {
        const attempts = [...m.attempts];
        const idx = attempts.findIndex((a) => a.n === n);
        const next = { n, phase, note };
        if (idx >= 0) attempts[idx] = next;
        else attempts.push(next);
        return { ...m, attempts };
      });
    },
    [updateAi]
  );

  const openProject = useCallback((project: { id: string; title: string }) => {
    projectIdRef.current = project.id;
    convIdRef.current = undefined;
    pendingToolCallIdRef.current = undefined;
    setCurrentProjectId(project.id);
    setCurrentConversationId(undefined);
    setProjName(project.title || "未命名项目");
    setMessages([]);
    setCode("");
    setWriting(false);
    setBusy(false);
    setHasResult(false);
    setPreviewActive(false);
    setOverlay(EMPTY_OVERLAY);
    setStatus({ kind: "", text: "选择会话或继续输入" });
  }, []);

  const openConversation = useCallback(
    async (project: { id: string; title: string }, conversationId: string, rows: StoredMessage[]) => {
      projectIdRef.current = project.id;
      convIdRef.current = conversationId;
      pendingToolCallIdRef.current = undefined;
      setCurrentProjectId(project.id);
      setCurrentConversationId(conversationId);
      setProjName(project.title || "未命名项目");
      setWriting(false);
      setBusy(false);
      setOverlay(EMPTY_OVERLAY);

      const restored: Message[] = [];
      let lastCode = "";
      for (const row of rows) {
        const meta = (row.meta ?? {}) as StoredMeta;
        if (row.role === "user") {
          restored.push({ id: row.id, role: "user", text: row.content });
        } else if (row.role === "assistant") {
          if (meta.kind === "code") {
            lastCode = row.content;
            restored.push({
              id: row.id,
              role: "ai",
              attempts: [{ n: 1, phase: "ok" }],
              summary: "历史代码回复",
              summaryKind: "ok",
            });
          } else {
            restored.push({ id: row.id, role: "ai", attempts: [], chatText: row.content });
          }
        }
      }

      setMessages(restored);
      setCode(lastCode);
      setHasResult(!!lastCode);
      setPreviewActive(!!lastCode);

      if (!lastCode) {
        setStatus({ kind: "", text: "这条会话还没有代码" });
        return;
      }

      setStatus({ kind: "load", text: "恢复预览中…" });
      try {
        const js = await transpile(lastCode);
        const sandbox = ensureSandbox();
        if (!sandbox) {
          setStatus({ kind: "", text: "历史代码已加载" });
          return;
        }
        const result = await withTimeout(sandbox.run(js), RESTORE_TIMEOUT_MS);
        if (result?.type === ToolResultType.RenderOk) {
          setStatus({ kind: "ok", text: "历史预览已恢复" });
          setOverlay((o) => ({ ...o, show: false }));
        } else if (result) {
          setStatus({ kind: "err", text: "历史代码运行报错" });
          setOverlay({ show: true, message: result.message, stack: result.stack, showStack: false });
        } else {
          setStatus({ kind: "", text: "历史代码已加载" });
        }
      } catch (e) {
        setStatus({ kind: "err", text: "历史代码编译报错" });
        setOverlay({ show: true, message: String(e instanceof Error ? e.message : e), stack: "", showStack: false });
      }
    },
    [ensureSandbox]
  );

  // 一轮 agent loop：流式取结果 → 转译 → 沙箱 → 出错回喂（自我修复）
  const runLoop = useCallback(
    async (firstMessage: string) => {
      let turn: ChatTurn = {
        kind: "user",
        message: firstMessage,
        projectId: projectIdRef.current,
        conversationId: convIdRef.current,
      };

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (abortRef.current.aborted) return;
        setAttempt(attempt, "writing");
        setWriting(true);
        setStatus({ kind: "load", text: "AI 正在写代码…" });

        // 1) 流式取后端结果。每轮重置：code 是增量 delta，从空开始 append
        let codeText = "";
        let gotCode = false;
        setCode("");
        try {
          for await (const ev of streamChat(turn)) {
            if (abortRef.current.aborted) return;
            if (ev.type === "tools_call") {
              pendingToolCallIdRef.current = ev.id;
            }
            if (ev.type === "init") {
              // 后端懒建了项目/会话 → 存下来，后续轮次带着续聊
              projectIdRef.current = ev.projectId;
              convIdRef.current = ev.conversationId;
              setCurrentProjectId(ev.projectId);
              setCurrentConversationId(ev.conversationId);
            } else if (ev.type === "code") {
              gotCode = true;
              codeText += ev.delta;            // 累积全量（给转译/沙箱用）
              setCode((c) => c + ev.delta);    // 编辑器增量追加
            } else if (ev.type === "chat") {
              updateAi((m) => ({ ...m, chatText: (m.chatText ?? "") + ev.delta }));
            } else if (ev.type === "title") {
              if (ev.projectTitle) setProjName(ev.projectTitle);
              setLastTitleUpdate({ conversationId: ev.conversationId, title: ev.title, projectTitle: ev.projectTitle });
            } else if (ev.type === "error") {
              throw new Error(ev.message);
            }
            // "done" 忽略，以流关闭为准
          }
        } catch (e: any) {
          setWriting(false);
          setStatus({ kind: "err", text: "请求失败", meta: "" });
          setOverlay({ show: true, message: String(e?.message ?? e), stack: "", showStack: false });
          updateAi((m) => ({ ...m, summaryKind: "fail", summary: "调用后端失败" }));
          setBusy(false);
          return;
        }
        setWriting(false);

        // 2) AI 没写代码（在提问/回话）→ 停下等用户
        if (!gotCode) {
          setStatus({ kind: "", text: "等待你的回复" });
          setBusy(false);
          return;
        }

        // 3) 转译
        setStatus({ kind: "load", text: "转译中…（esbuild-wasm）" });
        setAttempt(attempt, "transpiling");
        let js: string;
        try {
          js = await transpile(codeText);
        } catch (e) {
          const failures =
            e instanceof TranspileError ? e.failures : [{ text: String(e), location: null }];
          const txt = failures.map((f) => f.text).join("; ");
          setAttempt(attempt, "compile-fail", txt);
          setStatus({ kind: "err", text: "编译报错", meta: `· 第${attempt}次` });
          setOverlay({ show: true, message: "编译错误：" + txt, stack: "", showStack: false });
          setPreviewActive(true);

          const toolCallId = pendingToolCallIdRef.current;
          pendingToolCallIdRef.current = undefined;
          if (convIdRef.current && toolCallId) {
            await postToolResult(convIdRef.current, toolCallId, {
              status: "error",
              type: ToolResultType.CompileError,
              message: txt,
            });
            if (attempt === MAX_ATTEMPTS) return finishFail();
            turn = { kind: "resume", conversationId: convIdRef.current };
          } else {
            if (attempt === MAX_ATTEMPTS) return finishFail();
            turn = {
              kind: "user",
              message: `代码编译失败：${txt}\n\n当前代码：\n${codeText}\n\n请修复后输出完整代码。`,
              projectId: projectIdRef.current,
              conversationId: convIdRef.current,
            };
          }
          continue;
        }

        // 4) 跑沙箱
        setStatus({ kind: "load", text: "执行中…" });
        setAttempt(attempt, "running");
        setPreviewActive(true);
        const t0 = performance.now();
        const result = await ensureSandbox()!.run(js);
        const dur = Math.round(performance.now() - t0);
        if (abortRef.current.aborted) return;

        // 5) 读结果
        if (result.type === ToolResultType.RenderOk) {
          const toolCallId = pendingToolCallIdRef.current;
          pendingToolCallIdRef.current = undefined;
          if (convIdRef.current && toolCallId) {
            await postToolResult(convIdRef.current, toolCallId, {
              status: "ok",
              type: ToolResultType.RenderOk,
              durationMs: dur,
            });
          }
          setAttempt(attempt, "ok");
          setStatus({ kind: "ok", text: "渲染成功", meta: `· 第${attempt}次 · ${dur}ms` });
          setOverlay((o) => ({ ...o, show: false }));
          setHasResult(true);
          updateAi((m) => ({
            ...m,
            summaryKind: "ok",
            summary: attempt > 1 ? `已修复 ✓ 第 ${attempt} 次渲染成功` : "已生成 ✓ 渲染成功",
            diff: attempt > 1 ? "AI 读取报错后自动修正" : undefined,
          }));
          setBusy(false);
          return;
        }

        setAttempt(attempt, "runtime-fail", result.message);
        setStatus({ kind: "err", text: "运行报错", meta: `· 第${attempt}次` });
        setOverlay({ show: true, message: result.message, stack: result.stack, showStack: false });

        const toolCallId = pendingToolCallIdRef.current;
        pendingToolCallIdRef.current = undefined;
        if (convIdRef.current && toolCallId) {
          await postToolResult(convIdRef.current, toolCallId, {
            status: "error",
            type: ToolResultType.RuntimeError,
            message: result.message,
            stack: result.stack,
          });
          if (attempt === MAX_ATTEMPTS) return finishFail();
          turn = { kind: "resume", conversationId: convIdRef.current };
        } else {
          if (attempt === MAX_ATTEMPTS) return finishFail();
          turn = {
            kind: "user",
            message: `运行报错，请修复后输出完整代码：\n${result.message}\n${result.stack}\n\n当前代码：\n${codeText}`,
            projectId: projectIdRef.current,
            conversationId: convIdRef.current,
          };
        }
      }

      function finishFail() {
        updateAi((m) => ({ ...m, summaryKind: "fail", summary: "尝试多次仍未修复 ✕，可重试或手动接管" }));
        setStatus({ kind: "err", text: "未能修复", meta: "" });
        setBusy(false);
      }
    },
    [ensureSandbox, setAttempt, updateAi]
  );

  const send = useCallback(
    (prompt: string) => {
      if (busy || !prompt.trim() || !ensureSandbox()) return;
      const p = prompt.trim();
      lastPromptRef.current = p;

      const userId = crypto.randomUUID();
      const aiId = crypto.randomUUID();
      curAiIdRef.current = aiId;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: p },
        { id: aiId, role: "ai", attempts: [] },
      ]);
      setBusy(true);
      setHasResult(false);
      setOverlay(EMPTY_OVERLAY);
      setCode("");
      pendingToolCallIdRef.current = undefined;
      abortRef.current = { aborted: false };

      runLoop(p).catch((err) => {
        setBusy(false);
        setStatus({ kind: "err", text: "内部错误", meta: "" });
        setOverlay({ show: true, message: String(err?.message ?? err), stack: String(err?.stack ?? ""), showStack: false });
      });
    },
    [busy, ensureSandbox, runLoop]
  );

  const stop = useCallback(() => {
    abortRef.current.aborted = true;
    setBusy(false);
    setWriting(false);
    setStatus({ kind: "", text: "已停止" });
  }, []);

  const rerun = useCallback(() => {
    if (lastPromptRef.current) send(lastPromptRef.current);
  }, [send]);

  return {
    iframeRef,
    curAiId: curAiIdRef,
    messages,
    code,
    writing,
    projName,
    status,
    overlay,
    setOverlay,
    busy,
    hasResult,
    previewActive,
    currentProjectId,
    currentConversationId,
    lastTitleUpdate,
    openProject,
    openConversation,
    send,
    stop,
    rerun,
  };
}
