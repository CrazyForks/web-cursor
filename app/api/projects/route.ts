import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import z from "zod";


const CreateSchema = z.object({
    title: z.string().min(1),
})

// 列我的项目：排除软删，最近更新在前
export async function GET(req: Request) {
    const ownerId = req.headers.get("x-owner-id");
    if (!ownerId) return new Response("Unauthorized", { status: 401 });
    const rows = await db.select().from(projects)
        .where(and(eq(projects.ownerId, ownerId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.updatedAt));
    return Response.json(rows);
}

export async function POST(req: Request)  {
    const ownerId = req.headers.get("x-owner-id"); 
    if (!ownerId) {
        return new Response("Unauthorized", { status: 401 });
    }
    try {
        const { title } = CreateSchema.parse(await req.json());
        const project = await db.insert(projects).values({
            ownerId,
            title
        }).returning()
        return new Response(JSON.stringify(project), { status: 201 });
    } catch (e) {
        return new Response(JSON.stringify(e), { status: 400 });
    }
}