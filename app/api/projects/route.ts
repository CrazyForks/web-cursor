/**
 * [INPUT]: owner header；GET 列项目；POST strict database_v1/browser_git_v1 create body
 * [OUTPUT]: strict Project responses；Browser Git exact retry 返回同一项目
 * [POS]: A 域项目集合入口 —— Database 生成 ID，Browser Git 接受已 provision 的 client UUID
 * [PROTOCOL]: Browser Git 只对相同 owner/id/title/storage 幂等；冲突返回 409，不猜测兼容。
 */
import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import { ownerIdFrom } from "@/server/owner";
import { and, desc, eq, isNull } from "drizzle-orm";
import { CreateProjectBodySchema } from "@/types/projectStorage";
import { toProjectResponse } from "@/server/projectResponse";
import { ProjectStorageKind } from "@/types/projectStorage";

// 列我的项目：排除软删，最近更新在前
export async function GET(req: Request) {
    const ownerId = ownerIdFrom(req);
    if (!ownerId) return new Response("Unauthorized", { status: 401 });
    const rows = await db.select().from(projects)
        .where(and(eq(projects.ownerId, ownerId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.updatedAt));
    return Response.json(rows.map(toProjectResponse));
}

export async function POST(req: Request)  {
    const ownerId = ownerIdFrom(req);
    if (!ownerId) {
        return new Response("Unauthorized", { status: 401 });
    }

    const parsed = CreateProjectBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return Response.json({ error: "bad request", detail: parsed.error.flatten() }, { status: 400 });
    }

    try {
        if (parsed.data.storageKind === ProjectStorageKind.Database) {
            const project = await db.insert(projects).values({
                ownerId,
                title: parsed.data.title,
                storageKind: ProjectStorageKind.Database,
            }).returning();
            return Response.json(project.map(toProjectResponse), { status: 201 });
        }

        const [created] = await db.insert(projects).values({
            id: parsed.data.id,
            ownerId,
            title: parsed.data.title,
            storageKind: ProjectStorageKind.BrowserGit,
        }).onConflictDoNothing({ target: projects.id }).returning();

        if (created) {
            return Response.json([toProjectResponse(created)], { status: 201 });
        }

        const [existing] = await db.select().from(projects)
            .where(eq(projects.id, parsed.data.id))
            .limit(1);
        const isExactRetry = existing
            && existing.ownerId === ownerId
            && existing.deletedAt === null
            && existing.title === parsed.data.title
            && existing.storageKind === ProjectStorageKind.BrowserGit;
        if (!isExactRetry) {
            return Response.json({ error: "project id conflict" }, { status: 409 });
        }

        return Response.json([toProjectResponse(existing)], { status: 200 });
    } catch (e) {
        console.error("Failed to create project", e);
        return Response.json({ error: "internal error" }, { status: 500 });
    }
}
