export const ToolName = {
  WriteApp: "write_app",
  Reply: "reply",
} as const;

export type ToolName = typeof ToolName[keyof typeof ToolName];

export const ToolResultType = {
  RenderOk: "RENDER_OK",
  CompileError: "COMPILE_ERROR",
  RuntimeError: "RUNTIME_ERROR",
  ToolInterrupted: "TOOL_INTERRUPTED",
} as const;

export type ToolResult =
  | { status: "ok"; type: typeof ToolResultType.RenderOk; durationMs?: number }
  | { status: "error"; type: typeof ToolResultType.CompileError; message: string }
  | { status: "error"; type: typeof ToolResultType.RuntimeError; message: string; stack?: string }
  | { status: "error"; type: typeof ToolResultType.ToolInterrupted; message: string };

export type ToolCallMeta = {
  id: string;
  name: ToolName | string;
  arguments?: string;
};
