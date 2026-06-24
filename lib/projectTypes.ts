export type Project = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
};

export type Conversation = {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
};

export type ProjectDetail = Project & {
  conversations: Conversation[];
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  meta?: unknown;
};

export function formatTime(value?: string) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeCreatedProject(value: Project | Project[]): Project {
  return Array.isArray(value) ? value[0] : value;
}
