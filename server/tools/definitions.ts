/**
 * [INPUT]: 无
 * [OUTPUT]: OpenAI-compatible tools schema for DeepSeek function calling
 * [POS]: A 域工具定义层 —— 只描述 LLM 可见工具，不执行工具
 * [PROTOCOL]: 新增/修改工具先改这里，再同步 types/toolSchema.ts 和 executor.ts
 */
import "server-only";
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "@/types/projectStorage";
import { SearchTextLimits, ToolName } from "@/types/tool";

const baseToolDefinitions = [
  {
    name: ToolName.ListFiles,
    description: "列出当前项目的文件路径和 revision。用于在修改前了解项目结构；后续 mutation 必须携带返回的 revision。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.SearchText,
    description:
      `在当前项目已保存的文件内容中执行大小写敏感的单行字面量搜索，不支持正则。返回 project revision，以及最多 ${SearchTextLimits.Matches} 个 occurrence 的 1-based 行列和截断 snippet；truncated=true 表示还有更多结果。用于定位候选文件，修改前仍必须调用 read_file。`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: SearchTextLimits.QueryCodePoints,
          pattern: "^[^\\r\\n\\u2028\\u2029\\u0000]*\\S[^\\r\\n\\u2028\\u2029\\u0000]*$",
          description: `要原样匹配的单行文本，最长 ${SearchTextLimits.QueryCodePoints} 个 Unicode code point，例如组件名、import 路径或错误消息片段。不会被当作正则表达式。`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.ReadFile,
    description: "读取当前项目中某个文件的完整内容和 revision。修改已有文件前必须先读取，并把返回的 revision 作为 expectedRevision。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "项目内文件路径，例如 src/App.tsx 或 src/components/Button.tsx",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.WriteFile,
    description: "创建或完整覆盖项目中的一个文件。content 必须是完整文件内容，不是 patch。每轮只调用一个文件 mutation，成功后使用结果中的新 revision。写 package.json 时必须声明 Rsbuild React 项目所需 scripts、dependencies 和 devDependencies；不要写 Vite 或 esm.sh/webCursor 配置。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "项目内文件路径，例如 src/App.tsx 或 src/components/Button.tsx",
        },
        content: {
          type: "string",
          description: "完整文件内容。不要包含 markdown 代码块围栏。",
        },
        expectedRevision: {
          type: "integer",
          minimum: 0,
          description: "最近一次 list_files、search_text 或 read_file 返回的 project revision。冲突后必须重新读取，不能猜测。",
        },
      },
      required: ["path", "content", "expectedRevision"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.DeleteFile,
    description: "删除当前项目中的一个文件。删除必须显式调用本工具；每轮只调用一个文件 mutation，成功后使用结果中的新 revision。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要删除的项目内文件路径，例如 components/OldButton.tsx",
        },
        expectedRevision: {
          type: "integer",
          minimum: 0,
          description: "最近一次读取返回的 project revision。冲突后必须重新读取，不能猜测。",
        },
      },
      required: ["path", "expectedRevision"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.RenameFile,
    description: "重命名或移动当前项目中的一个文件。移动文件也使用本工具；每轮只调用一个文件 mutation，成功后使用结果中的新 revision。",
    parameters: {
      type: "object",
      properties: {
        oldPath: {
          type: "string",
          description: "原项目内文件路径，例如 src/components/Button.tsx",
        },
        newPath: {
          type: "string",
          description: "新项目内文件路径，例如 components/PrimaryButton.tsx",
        },
        expectedRevision: {
          type: "integer",
          minimum: 0,
          description: "最近一次读取返回的 project revision。冲突后必须重新读取，不能猜测。",
        },
      },
      required: ["oldPath", "newPath", "expectedRevision"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.RunPreview,
    description:
      "在浏览器 WebContainer 中安装依赖并运行当前 Rsbuild 项目，返回 SERVER_READY、INSTALL_ERROR、DEV_SERVER_ERROR 或 BROWSER_RUNTIME_ERROR。只在一组自洽项目文件改动完成后做阶段性验收；不要在项目骨架未完整、本地 import 未闭合或明显半成品状态下调用。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.InspectAttachment,
    description:
      "识别用户在当前会话中上传的附件内容。工具只返回附件中可见事实；后续如何使用由 agent 决定。只能读取后端在上下文中列出的 attachmentId。",
    parameters: {
      type: "object",
      properties: {
        attachmentId: {
          type: "string",
          description: "当前会话可检查的附件 id。必须来自用户消息中列出的 attachmentId。",
        },
      },
      required: ["attachmentId"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.InspectFigmaDesign,
    description:
      "读取用户提供的 Figma frame/node 链接，返回经过服务端校验和压缩的设计事实。必须提供包含 node-id 的 figma.com/design 或 figma.com/file URL；不要猜测未返回的设计内容或图片 URL。",
    parameters: {
      type: "object",
      properties: {
        figmaUrl: {
          type: "string",
          description: "用户提供的 Figma design/file URL，必须包含 node-id，例如 https://www.figma.com/design/FILE/name?node-id=1-2",
        },
        maxDepth: {
          type: "number",
          description: "可选。返回 Figma 节点树的最大深度，默认 4，最大 8。",
        },
        includeAssets: {
          type: "boolean",
          description: "是否请求目标节点的临时 Figma 导出图片 URL。只有需要引用视觉资产时才设为 true。",
        },
      },
      required: ["figmaUrl", "includeAssets"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.GenerateImage,
    description:
      "异步生成一组网页视觉图片资产。用于独立站、营销页、产品页需要 hero 图、产品场景图、功能配图、背景视觉等真实图片资产时调用。prompt 是唯一生图语义来源；label 只用于前端展示。",
    parameters: {
      type: "object",
      properties: {
        images: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "给用户看的简短名称，例如 Hero visual。只用于 UI 展示，不影响生图语义。",
              },
              prompt: {
                type: "string",
                description: "完整图片生成提示词，必须描述内容、风格、用途和构图；不要依赖 label 表达语义。",
              },
              aspectRatio: {
                type: "string",
                enum: ["1:1", "4:3", "3:2", "16:9", "21:9", "9:16"],
                description: "期望构图比例。如果 provider 不支持显式比例，后端会作为 prompt 约束处理。",
              },
              inputImages: {
                type: "array",
                maxItems: 4,
                description:
                  "可选参考图片。只能引用当前会话已上传附件或项目内已有资产；不要传任意 URL 或 base64。",
                items: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        source: {
                          type: "string",
                          enum: ["attachment"],
                        },
                        attachmentId: {
                          type: "string",
                          description: "当前会话附件 id，必须来自用户消息列出的 attachmentId。",
                        },
                      },
                      required: ["source", "attachmentId"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        source: {
                          type: "string",
                          enum: ["project_asset"],
                        },
                        assetId: {
                          type: "string",
                          description: "项目资产 id，必须来自已有工具结果或资产查询结果。",
                        },
                      },
                      required: ["source", "assetId"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            required: ["prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["images"],
      additionalProperties: false,
    },
  },
] as const;

const browserGitToolDefinitions = [
  {
    name: ToolName.GitStatus,
    description:
      "读取当前 Browser Git 项目的 working tree 与 index 状态，只返回有变更的文件。head !== stage 表示有 staged change；workdir !== stage 表示有 unstaged change；files 为空表示仓库干净。不会修改仓库。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.GitStage,
    description:
      "把 Browser Git working tree 中一个明确路径的当前状态加入 index。删除文件也使用该工具暂存删除；每次只传一个真实路径。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "git_status 返回的项目内文件路径。",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.GitUnstage,
    description:
      "把 Browser Git index 中一个明确路径恢复为 HEAD 状态，不修改 working tree 文件内容。每次只传一个真实路径。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "git_status 返回的项目内文件路径。",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.GitCommit,
    description:
      "提交 Browser Git index 中已经暂存的变更。只有用户明确要求提交并明确提供 Git 作者姓名与邮箱时才能调用；不得猜测作者身份。",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          minLength: 1,
          description: "非空提交消息。",
        },
        author: {
          type: "object",
          properties: {
            name: {
              type: "string",
              minLength: 1,
              description: "用户明确提供的 Git 作者名称。",
            },
            email: {
              type: "string",
              format: "email",
              description: "用户明确提供的 Git 作者邮箱。",
            },
          },
          required: ["name", "email"],
          additionalProperties: false,
        },
      },
      required: ["message", "author"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.GitLog,
    description: "读取当前 Browser Git 项目的提交历史，不修改仓库。",
    parameters: {
      type: "object",
      properties: {
        depth: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "返回最近多少条提交。",
        },
      },
      required: ["depth"],
      additionalProperties: false,
    },
  },
  {
    name: ToolName.GitCurrentBranch,
    description: "读取当前 Browser Git 分支；未解析到分支时返回 null，不修改仓库。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
] as const;

export function toolDefinitionsForStorageKind(storageKind: ProjectStorageKindValue) {
  switch (storageKind) {
    case ProjectStorageKind.Database:
      return [...baseToolDefinitions];
    case ProjectStorageKind.BrowserGit:
      return [...baseToolDefinitions, ...browserGitToolDefinitions];
  }
}

export function toolsForStorageKind(storageKind: ProjectStorageKindValue) {
  return toolDefinitionsForStorageKind(storageKind).map((tool) => ({
    type: "function" as const,
    function: tool,
  }));
}
