/**
 * [INPUT]: project id + strict Browser Git activation body + owner header
 * [OUTPUT]: storage-discriminated Browser Git project metadata
 * [POS]: A 域 Database→Browser Git 存储激活 action route
 * [PROTOCOL]: 只在 Database source revision 未变化时原子切换唯一写源；不读取或验证浏览器文件内容
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import { ownerIdFrom } from "@/server/owner";
import { toProjectResponse } from "@/server/projectResponse";
import {
  executeProjectStorageMigration,
  ProjectStorageMigrationError,
  ProjectStorageMigrationErrorCode,
} from "@/server/projectStorageMigrationTransaction";
import { ActivateBrowserGitMigrationBodySchema } from "@/types/projectMigration";
import { ProjectStorageKind } from "@/types/projectStorage";

type Ctx = { params: Promise<{ id: string }> };
type ProjectTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProjectRow = typeof projects.$inferSelect;

export async function POST(req: Request, ctx: Ctx) {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;

  const migration = ActivateBrowserGitMigrationBodySchema.safeParse(await req.json().catch(() => null));
  if (!migration.success) {
    return Response.json({ error: "bad request", detail: migration.error.flatten() }, { status: 400 });
  }

  try {
    const row = await executeProjectStorageMigration<ProjectTransaction, ProjectRow>({
      sourceRevision: migration.data.sourceRevision,
      transaction: (operation) => db.transaction(operation),
      activate: async (tx) => {
        const [activated] = await tx.update(projects)
          .set({
            storageKind: ProjectStorageKind.BrowserGit,
            codeRevision: migration.data.localRevision,
            updatedAt: new Date(),
          })
          .where(and(
            eq(projects.id, id),
            eq(projects.ownerId, ownerId),
            isNull(projects.deletedAt),
            eq(projects.storageKind, ProjectStorageKind.Database),
            eq(projects.codeRevision, migration.data.sourceRevision),
          ))
          .returning();
        return activated ?? null;
      },
      inspectCurrent: async (tx) => {
        const [current] = await tx.select({
          storageKind: projects.storageKind,
          revision: projects.codeRevision,
        }).from(projects)
          .where(and(
            eq(projects.id, id),
            eq(projects.ownerId, ownerId),
            isNull(projects.deletedAt),
          ))
          .limit(1);
        return current ?? null;
      },
    });
    return Response.json(toProjectResponse(row));
  } catch (error) {
    if (error instanceof ProjectStorageMigrationError) {
      const status = error.code === ProjectStorageMigrationErrorCode.NotFound ? 404 : 409;
      return Response.json({ error: error.code, detail: error.message }, { status });
    }
    console.error("Failed to migrate project storage", error);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
