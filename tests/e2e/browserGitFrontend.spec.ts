import { expect, test, type Page, type Route } from "@playwright/test";

const PROJECT_ID = "772cc805-cf12-4b10-b19d-9b4241e68af7";
const CONVERSATION_ID = "21a25592-5e6c-469d-b37f-1bca2ceadf83";
const CREATED_AT = "2026-07-17T08:00:00.000Z";
const README_CONTENT = "# E2E Browser Git\n";

type JsonRecord = Record<string, unknown>;

test.beforeEach(async ({ context }) => {
  await context.addCookies([{
    name: "NEXT_LOCALE",
    value: "zh",
    url: "http://127.0.0.1:3100",
  }]);
});

function sse(events: JsonRecord[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function fulfillSse(route: Route, events: JsonRecord[]) {
  await route.fulfill({
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
    body: sse(events),
  });
}

function browserGitProject(id = PROJECT_ID) {
  return {
    id,
    title: "untitled",
    storageKind: "browser_git_v1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

async function installBrowserGitFlow(page: Page) {
  const toolResults: JsonRecord[] = [];
  const chatTurns: JsonRecord[] = [];
  let createdProjectId: string | null = null;
  let resumeCount = 0;

  await page.route("**/api/projects", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, json: [] });
      return;
    }
    const body = request.postDataJSON() as JsonRecord;
    createdProjectId = String(body.id);
    expect(body).toEqual({
      id: createdProjectId,
      title: "untitled",
      storageKind: "browser_git_v1",
    });
    await route.fulfill({ status: 201, json: [browserGitProject(createdProjectId)] });
  });

  await page.route(/\/api\/projects\/[0-9a-f-]+$/, async (route) => {
    const id = route.request().url().split("/").at(-1)!;
    await route.fulfill({
      status: 200,
      json: { ...browserGitProject(id), conversations: [] },
    });
  });

  await page.route(/\/api\/conversations\/[0-9a-f-]+\/tool-results$/, async (route) => {
    toolResults.push(route.request().postDataJSON() as JsonRecord);
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as JsonRecord;
    chatTurns.push(body);
    if (body.kind === "user") {
      expect(body.projectId).toBe(createdProjectId);
      await fulfillSse(route, [
        {
          type: "init",
          conversationId: CONVERSATION_ID,
          repository: {
            projectId: createdProjectId,
            storageKind: "browser_git_v1",
            revision: 0,
          },
        },
        { type: "tools_call", index: 0, id: "call-list", name: "list_files" },
        {
          type: "client_tool_calls",
          calls: [{ id: "call-list", name: "list_files", arguments: "{}" }],
        },
      ]);
      return;
    }

    expect(body).toEqual({ kind: "resume", conversationId: CONVERSATION_ID });
    if (resumeCount === 0) {
      resumeCount += 1;
      await fulfillSse(route, [
        { type: "tools_call", index: 0, id: "call-write", name: "write_file" },
        {
          type: "client_tool_calls",
          calls: [{
            id: "call-write",
            name: "write_file",
            arguments: JSON.stringify({
              path: "README.md",
              content: README_CONTENT,
              expectedRevision: 0,
            }),
          }],
        },
      ]);
      return;
    }

    await fulfillSse(route, [
      { type: "chat", delta: "Browser Git E2E completed" },
      { type: "done" },
    ]);
  });

  return { toolResults, chatTurns, createdProjectId: () => createdProjectId };
}

test("user can select Browser Git, let Agent write locally, and reopen after refresh", async ({ page }) => {
  const flow = await installBrowserGitFlow(page);
  await page.goto("/");

  const database = page.getByRole("button", { name: /Database/ });
  const browserGit = page.getByRole("button", { name: /Browser Git/ });
  await expect(database).toHaveAttribute("aria-pressed", "true");
  await expect(browserGit).toHaveAttribute("aria-pressed", "false");

  await browserGit.click();
  await expect(browserGit).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("本地存储：清除站点数据、换浏览器或换设备后无法恢复。")).toBeVisible();

  await page.getByRole("textbox").fill("创建 Browser Git E2E 项目说明");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("Browser Git E2E completed")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('button[title="README.md"]')).toBeVisible();
  await expect.poll(() => flow.toolResults.length).toBe(2);

  const projectId = flow.createdProjectId();
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
  expect(flow.chatTurns).toEqual([
    expect.objectContaining({
      kind: "user",
      message: "创建 Browser Git E2E 项目说明",
      projectId,
    }),
    { kind: "resume", conversationId: CONVERSATION_ID },
    { kind: "resume", conversationId: CONVERSATION_ID },
  ]);
  expect(flow.toolResults).toEqual([
    {
      projectId,
      toolCallId: "call-list",
      tool: "list_files",
      result: { status: "ok", tool: "list_files", revision: 0, files: [] },
    },
    {
      projectId,
      toolCallId: "call-write",
      tool: "write_file",
      result: expect.objectContaining({
        status: "ok",
        tool: "write_file",
        revision: 1,
        path: "README.md",
      }),
    },
  ]);

  await expect(page).toHaveURL(`/p/${projectId}`);
  await page.reload();
  await expect(page.locator('button[title="README.md"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('section div[title="README.md"]')).toBeVisible();
});

test("project metadata without a local repository shows the explicit missing state", async ({ page }) => {
  const missingProjectId = "32ef75e4-1226-42ef-a026-8d851d5b7533";
  await page.route(new RegExp(`/api/projects/${missingProjectId}$`), async (route) => {
    await route.fulfill({
      status: 200,
      json: { ...browserGitProject(missingProjectId), conversations: [] },
    });
  });

  await page.goto(`/p/${missingProjectId}`);
  await expect(page.getByRole("heading", { name: "当前浏览器中找不到这个 Git 仓库" })).toBeVisible();
  await expect(page.getByText(/不会创建空仓库或回退到数据库/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
});

test("existing Database project migrates to Browser Git and reopens from the local repository", async ({ page }) => {
  const migrationProjectId = "e3955533-56a7-4934-8fe8-923f8f938a57";
  const sourceRevision = 4;
  const sourceContent = "# migrated Database project\n";
  let activated = false;
  let activationBody: JsonRecord | null = null;

  await page.route(new RegExp(`/api/projects/${migrationProjectId}$`), async (route) => {
    await route.fulfill({
      status: 200,
      json: activated
        ? { ...browserGitProject(migrationProjectId), title: "Legacy project", conversations: [] }
        : {
            id: migrationProjectId,
            title: "Legacy project",
            storageKind: "database_v1",
            codeRevision: sourceRevision,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            conversations: [],
            files: [{ path: "README.md", updatedAt: CREATED_AT }],
          },
    });
  });

  await page.route(new RegExp(`/api/projects/${migrationProjectId}/migrate-browser-git$`), async (route) => {
    expect(route.request().method()).toBe("POST");
    activationBody = route.request().postDataJSON() as JsonRecord;
    expect(activationBody).toMatchObject({
      sourceRevision,
      localRevision: sourceRevision,
    });
    expect(activationBody).not.toHaveProperty("action");
    expect(String(activationBody.importCommitOid)).toMatch(/^[0-9a-f]{40}$/);
    activated = true;
    await route.fulfill({
      status: 200,
      json: { ...browserGitProject(migrationProjectId), title: "Legacy project" },
    });
  });

  await page.route(new RegExp(`/api/projects/${migrationProjectId}/files\\?includeContent=1$`), async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        revision: sourceRevision,
        files: [{ path: "README.md", content: sourceContent, updatedAt: CREATED_AT }],
      },
    });
  });

  await page.goto(`/p/${migrationProjectId}`);
  await expect(page.getByText("当前源码存储：Database")).toBeVisible();
  await expect(page.locator('button[title="README.md"]')).toBeVisible();
  await page.locator('button[title="README.md"]').click();
  const editorWorkspace = page.getByTestId("editor-workspace");
  await expect(editorWorkspace).toBeVisible();
  const editorWorkspaceBox = await editorWorkspace.boundingBox();
  expect(editorWorkspaceBox?.height).toBeGreaterThan(300);
  await page.getByRole("button", { name: "转换为浏览器 Git" }).click();

  const dialog = page.getByRole("dialog", { name: "将项目转换为浏览器 Git" });
  await expect(dialog.getByText(/本期不提供云端同步/)).toBeVisible();
  await dialog.getByLabel("Git 作者姓名").fill("E2E Migration User");
  await dialog.getByLabel("Git 作者邮箱").fill("migration-e2e@example.com");
  await dialog.getByRole("button", { name: "确认转换" }).click();

  await expect(page.getByText("当前源码存储：浏览器 Git")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('button[title="README.md"]')).toBeVisible();
  expect(activated).toBe(true);
  expect(activationBody).not.toBeNull();

  await page.reload();
  await expect(page.getByText("当前源码存储：浏览器 Git")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('button[title="README.md"]')).toBeVisible();
  await page.locator('button[title="README.md"]').click();
  await expect(page.locator('section div[title="README.md"]')).toBeVisible();
});
