import { describe, expect, it } from "vitest";
import {
  FileContentAction,
  FileContentPostBodySchema,
  RenameProjectFileBodySchema,
} from "../../types/projectFileMutation";
import { ProjectRevisionSchema } from "../../types/projectRevision";
import { executeRevisionedMutation } from "../../server/projectRevisionTransaction";
import {
  DeleteFileArgsSchema,
  RenameFileArgsSchema,
  WriteFileArgsSchema,
} from "../../types/toolSchema";

describe("ProjectRevisionSchema", () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts a safe non-negative integer: %s", (value) => {
    expect(ProjectRevisionSchema.parse(value)).toBe(value);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined])(
    "rejects an invalid project revision: %s",
    (value) => {
      expect(ProjectRevisionSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("project file mutation contracts", () => {
  it("requires expectedRevision for write", () => {
    expect(FileContentPostBodySchema.safeParse({
      action: FileContentAction.Write,
      path: "src/App.tsx",
      content: "export default function App() {}",
    }).success).toBe(false);
  });

  it("requires expectedRevision for delete", () => {
    expect(FileContentPostBodySchema.safeParse({
      action: FileContentAction.Delete,
      path: "src/App.tsx",
    }).success).toBe(false);
  });

  it("requires expectedRevision for rename", () => {
    expect(RenameProjectFileBodySchema.safeParse({
      oldPath: "src/App.tsx",
      newPath: "src/Main.tsx",
    }).success).toBe(false);
  });

  it("accepts exact write, delete, and rename contracts", () => {
    expect(FileContentPostBodySchema.parse({
      action: FileContentAction.Write,
      path: "src/App.tsx",
      content: "export default function App() {}",
      expectedRevision: 3,
    })).toEqual({
      action: FileContentAction.Write,
      path: "src/App.tsx",
      content: "export default function App() {}",
      expectedRevision: 3,
    });

    expect(FileContentPostBodySchema.parse({
      action: FileContentAction.Delete,
      path: "src/App.tsx",
      expectedRevision: 4,
    })).toEqual({
      action: FileContentAction.Delete,
      path: "src/App.tsx",
      expectedRevision: 4,
    });

    expect(RenameProjectFileBodySchema.parse({
      oldPath: "src/App.tsx",
      newPath: "src/Main.tsx",
      expectedRevision: 5,
    })).toEqual({
      oldPath: "src/App.tsx",
      newPath: "src/Main.tsx",
      expectedRevision: 5,
    });
  });

  it("rejects unknown mutation fields", () => {
    expect(FileContentPostBodySchema.safeParse({
      action: FileContentAction.Delete,
      path: "src/App.tsx",
      expectedRevision: 1,
      force: true,
    }).success).toBe(false);
  });
});

describe("agent file mutation contracts", () => {
  it.each([
    [WriteFileArgsSchema, { path: "src/App.tsx", content: "next" }],
    [DeleteFileArgsSchema, { path: "src/App.tsx" }],
    [RenameFileArgsSchema, { oldPath: "src/App.tsx", newPath: "src/Main.tsx" }],
  ])("requires expectedRevision", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("accepts the revision returned by a prior read", () => {
    expect(WriteFileArgsSchema.parse({
      path: "src/App.tsx",
      content: "next",
      expectedRevision: 7,
    }).expectedRevision).toBe(7);
  });
});

describe("executeRevisionedMutation", () => {
  it("does not run the file mutation when the revision claim is stale", async () => {
    let mutationCalls = 0;

    await expect(executeRevisionedMutation<Record<string, never>, string>({
      transaction: async (operation) => operation({}),
      claimRevision: async () => null,
      mutate: async () => {
        mutationCalls += 1;
        return "changed";
      },
      revisionConflict: () => new Error("stale revision"),
    })).rejects.toThrow("stale revision");

    expect(mutationCalls).toBe(0);
  });

  it("returns the claimed revision only after the file mutation succeeds", async () => {
    const events: string[] = [];

    const result = await executeRevisionedMutation<Record<string, never>, string>({
      transaction: async (operation) => {
        events.push("transaction:start");
        const value = await operation({});
        events.push("transaction:commit");
        return value;
      },
      claimRevision: async () => {
        events.push("revision:claimed");
        return 8;
      },
      mutate: async () => {
        events.push("file:mutated");
        return "saved";
      },
      revisionConflict: () => new Error("stale revision"),
    });

    expect(result).toEqual({ value: "saved", revision: 8 });
    expect(events).toEqual([
      "transaction:start",
      "revision:claimed",
      "file:mutated",
      "transaction:commit",
    ]);
  });

  it("lets the transaction roll back when the file mutation fails", async () => {
    const persisted = { revision: 4, content: "before" };

    await expect(executeRevisionedMutation<{ revision: number; content: string }, never>({
      transaction: async (operation) => {
        const draft = { ...persisted };
        const result = await operation(draft);
        Object.assign(persisted, draft);
        return result;
      },
      claimRevision: async (draft) => {
        draft.revision += 1;
        return draft.revision;
      },
      mutate: async (draft) => {
        draft.content = "after";
        throw new Error("write failed");
      },
      revisionConflict: () => new Error("stale revision"),
    })).rejects.toThrow("write failed");

    expect(persisted).toEqual({ revision: 4, content: "before" });
  });
});
