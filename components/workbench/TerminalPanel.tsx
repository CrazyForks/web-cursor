"use client";

import { RotateCcw, TerminalSquare } from "lucide-react";
import { TerminalPhase, useWebContainerTerminal } from "@/hooks/useWebContainerTerminal";
import type { WebContainerProjectFile } from "@/lib/webcontainer/types";

export default function TerminalPanel({
  active,
  projectId,
  readProjectFiles,
}: {
  active: boolean;
  projectId?: string;
  readProjectFiles: (projectId: string) => Promise<WebContainerProjectFile[]>;
}) {
  const terminal = useWebContainerTerminal({ active, projectId, readProjectFiles });

  if (!projectId) {
    return (
      <div className="grid h-full place-items-center text-xs text-muted">
        创建或打开项目后可启动终端。
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 bg-[#11110f]">
      <div ref={terminal.hostRef} className="h-full px-2 py-1" />
      {terminal.phase === TerminalPhase.Starting && (
        <div className="absolute inset-0 grid place-items-center bg-[#11110f]/90 text-xs text-muted">
          正在启动 WebContainer 终端…
        </div>
      )}
      {terminal.phase === TerminalPhase.Error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#11110f] px-6 text-center">
          <TerminalSquare size={22} className="text-red" />
          <p className="max-w-xl text-xs leading-5 text-[#ffd0cc]">{terminal.error}</p>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-fg hover:border-accent"
            onClick={terminal.restart}
          >
            <RotateCcw size={13} />
            重新启动
          </button>
        </div>
      )}
    </div>
  );
}
