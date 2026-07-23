/**
 * [INPUT]: Composer 的 prompt/attachments、storage 选择与 Browser Git 创建服务
 * [OUTPUT]: Database 直接启动，或 Browser Git 创建成功后携 projectId 通知 HomePage
 * [POS]: B 域首页项目启动状态 owner —— 拥有 storage、busy、error 与重试 UUID
 * [PROTOCOL]: Browser Git 重试复用 UUID；创建期间禁止重复提交；Database 不提前创建项目。
 */
"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Database, GitBranch } from "lucide-react";
import Composer from "@/components/chat/Composer";
import { createBrowserGitProject } from "@/lib/projectCreation/client";
import type { SendAttachment } from "@/lib/types";
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "@/types/projectStorage";

export type ProjectStartPayload = {
  prompt: string;
  attachments: SendAttachment[];
  projectId?: string;
};

type ProjectStarterProps = {
  resetSignal: number;
  onStart: (payload: ProjectStartPayload) => void;
};

const DEFAULT_PROJECT_TITLE = "untitled";

export default function ProjectStarter({ resetSignal, onStart }: ProjectStarterProps) {
  const home = useTranslations("Home");
  const [selectedStorage, setSelectedStorage] = useState<ProjectStorageKindValue>(ProjectStorageKind.Database);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const pendingBrowserProjectIdRef = useRef<string | null>(null);

  async function startProject(prompt: string, attachments: SendAttachment[] = []) {
    if (selectedStorage === ProjectStorageKind.Database) {
      onStart({ prompt, attachments });
      return;
    }
    if (busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);
    const projectId = pendingBrowserProjectIdRef.current ?? crypto.randomUUID();
    pendingBrowserProjectIdRef.current = projectId;

    try {
      await createBrowserGitProject(projectId, DEFAULT_PROJECT_TITLE);
      pendingBrowserProjectIdRef.current = null;
      onStart({ prompt, attachments, projectId });
    } catch (creationError) {
      const detail = creationError instanceof Error ? creationError.message : String(creationError);
      setError(`${home("browserGitProvisionFailed")}: ${detail}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const storageOptions = [
    {
      kind: ProjectStorageKind.Database,
      label: home("databaseStorage"),
      description: home("databaseStorageDescription"),
      icon: Database,
    },
    {
      kind: ProjectStorageKind.BrowserGit,
      label: home("browserGitStorage"),
      description: home("browserGitStorageDescription"),
      icon: GitBranch,
    },
  ] as const;

  return (
    <>
      <fieldset className="mb-3" disabled={busy}>
        <legend className="mb-2 px-1 text-[12px] font-medium text-[#8c877d]">{home("storageLabel")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {storageOptions.map((option) => {
            const active = selectedStorage === option.kind;
            const Icon = option.icon;
            return (
              <button
                key={option.kind}
                type="button"
                className={
                  "flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-wait disabled:opacity-60 "
                  + (active
                    ? "border-[#f54e00] bg-[#211108] text-[#f7f7f4]"
                    : "border-[#2d2a24] bg-[#0b0b0a] text-[#8c877d] hover:border-[#5a3a28]")
                }
                aria-pressed={active}
                onClick={() => {
                  setSelectedStorage(option.kind);
                  setError(null);
                }}
              >
                <Icon size={17} className={active ? "text-[#f54e00]" : "text-[#6f6a60]"} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{option.label}</span>
                  <span className="block truncate text-[11px] text-[#807a70]">{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>
        {selectedStorage === ProjectStorageKind.BrowserGit && (
          <p className="mt-2 px-1 text-[11px] leading-5 text-amber-400">{home("browserGitWarning")}</p>
        )}
        {error && (
          <p className="mt-2 break-words px-1 text-[11px] leading-5 text-red-400" role="alert">
            {error}
          </p>
        )}
      </fieldset>

      <Composer
        busy={busy}
        onSend={(prompt, attachments) => void startProject(prompt, attachments)}
        containerClassName=""
        boxClassName="rounded-[22px] border border-[#2d2a24] bg-[#0b0b0a] p-3 shadow-[0_18px_70px_rgba(0,0,0,0.28)] transition focus-within:border-[#5a3a28]"
        textareaClassName="min-h-[92px] w-full resize-none border-0 bg-transparent px-2 py-2 text-[16px] leading-7 text-[#f7f7f4] outline-none placeholder:text-[#6f6a60]"
        footerClassName="flex items-center justify-between gap-3 px-1 pt-2"
        submitLabel={home("generate")}
        resetSignal={resetSignal}
        submitButtonClassName={(canSend) =>
          "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition disabled:cursor-not-allowed "
          + (canSend ? "bg-[#f54e00] text-white hover:bg-[#d94300]" : "bg-[#171511] text-[#6f6a60]")
        }
      />
    </>
  );
}
