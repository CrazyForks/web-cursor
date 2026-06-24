import "server-only"; // A 域守卫：DB 客户端误 import 进客户端组件会编译期报错
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });