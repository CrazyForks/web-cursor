"use client";

import { FormEvent, useState } from "react";
import { FileCode2, FolderOpen, Plus, X } from "lucide-react";
import type { ProjectFileSummary } from "@/lib/projectTypes";

export default function ProjectExplorer({
  files,
  activePath,
  onOpenFile,
  onNewFile,
}: {
  files: ProjectFileSummary[];
  activePath?: string;
  onOpenFile(path: string): void;
  onNewFile(path: string): void | Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [path, setPath] = useState("src/components/NewFile.tsx");
  const [error, setError] = useState("");

  async function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!path.trim()) return;
    setError("");
    try {
      await onNewFile(path.trim());
      setCreating(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Explorer">
      <div className="flex h-9 flex-none items-center px-4 text-[11px] uppercase tracking-[0.08em] text-muted">
        <span>Explorer</span>
        <button
          type="button"
          className="ml-auto grid h-6 w-6 place-items-center rounded hover:bg-panel2 hover:text-fg"
          aria-label="新建文件"
          title="新建文件"
          onClick={() => setCreating(true)}
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="flex h-8 flex-none items-center gap-1.5 border-y border-border px-3 text-xs font-semibold text-fg">
        <FolderOpen size={14} className="text-accent" />
        PROJECT
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {creating && (
          <form className="border-b border-border px-2 pb-2" onSubmit={createFile}>
            <div className="flex gap-1">
              <input
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                className="min-w-0 flex-1 rounded border border-accent bg-codebg px-2 py-1 font-mono text-[11px] text-fg outline-none"
              />
              <button type="button" className="grid w-6 place-items-center text-muted hover:text-fg" onClick={() => setCreating(false)}>
                <X size={13} />
              </button>
            </div>
            {error && <p className="mt-1 text-[10px] leading-4 text-[#ffd0cc]">{error}</p>}
          </form>
        )}
        {files.length === 0 ? (
          <p className="px-4 py-3 text-xs leading-5 text-muted">项目中还没有文件。</p>
        ) : (
          files.toSorted((a, b) => a.path.localeCompare(b.path)).map((file) => {
            const active = file.path === activePath;
            return (
              <button
                key={file.path}
                type="button"
                className={
                  "flex h-7 w-full items-center gap-2 border-l-2 px-3 text-left font-mono text-[12px] transition " +
                  (active
                    ? "border-accent bg-[#24211d] text-fg"
                    : "border-transparent text-muted hover:bg-panel2 hover:text-fg")
                }
                title={file.path}
                onClick={() => onOpenFile(file.path)}
              >
                <FileCode2 size={13} className={active ? "text-accent" : "text-muted"} />
                <span className="truncate">{file.path}</span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
