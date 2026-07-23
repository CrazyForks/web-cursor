/**
 * [INPUT]: active project id, repository preview export, and whether the Terminal panel is visible
 * [OUTPUT]: xterm host ref, terminal lifecycle state, restart action
 * [POS]: B 域 Terminal 状态 owner —— 连接 Xterm 与共享 WebContainer jsh session
 * [PROTOCOL]: mount 只生成 runtime mirror；终端文件写入不回写 ProjectRepository，卸载时关闭当前 jsh。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openWebContainerTerminal } from "@/lib/webcontainer/runtime";
import type { WebContainerProjectFile } from "@/lib/webcontainer/types";

export const TerminalPhase = {
  Idle: "idle",
  Starting: "starting",
  Ready: "ready",
  Error: "error",
} as const;

export type TerminalPhase = typeof TerminalPhase[keyof typeof TerminalPhase];

export function useWebContainerTerminal({
  active,
  projectId,
  readProjectFiles,
}: {
  active: boolean;
  projectId?: string;
  readProjectFiles: (projectId: string) => Promise<WebContainerProjectFile[]>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<TerminalPhase>(TerminalPhase.Idle);
  const [error, setError] = useState("");
  const [restartKey, setRestartKey] = useState(0);

  const restart = useCallback(() => setRestartKey((value) => value + 1), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || !projectId || !host) return;

    let cancelled = false;
    let cleanup = () => undefined;
    setPhase(TerminalPhase.Starting);
    setError("");

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (cancelled) return;

        const terminal = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 1.3,
          scrollback: 3000,
          theme: {
            background: "#11110f",
            foreground: "#d7d4cc",
            cursor: "#f54e00",
            selectionBackground: "#3a322a",
          },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();
        terminal.writeln("\x1b[38;2;245;78;0mWeb Cursor runtime terminal\x1b[0m");
        terminal.writeln("文件系统是 Repository 的临时运行镜像；请在编辑器保存源码，在 Source Control 操作 Git。\r\n");

        const files = await readProjectFiles(projectId);
        if (cancelled) {
          terminal.dispose();
          return;
        }
        const session = await openWebContainerTerminal({
          files,
          cols: terminal.cols,
          rows: terminal.rows,
          onOutput: (text) => terminal.write(text),
        });
        if (cancelled) {
          session.dispose();
          terminal.dispose();
          return;
        }

        const input = terminal.onData((data) => void session.write(data));
        const observer = new ResizeObserver(() => {
          fit.fit();
          session.resize(terminal.cols, terminal.rows);
        });
        observer.observe(host);
        setPhase(TerminalPhase.Ready);
        cleanup = () => {
          observer.disconnect();
          input.dispose();
          session.dispose();
          terminal.dispose();
          host.replaceChildren();
        };
      } catch (cause) {
        if (cancelled) return;
        setPhase(TerminalPhase.Error);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [active, projectId, readProjectFiles, restartKey]);

  return { hostRef, phase, error, restart };
}
