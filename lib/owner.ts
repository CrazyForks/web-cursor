/**
 * [INPUT]: 无（读/写 localStorage）
 * [OUTPUT]: 稳定的匿名 owner id 字符串
 * [POS]: B 域身份源头 —— id 只在这里诞生一次，供 api.ts / streamChat 带上 x-owner-id
 * [PROTOCOL]: 非鉴权，仅数据隔离；换设备 / 清缓存 = 新身份。后端只读取、不校验格式
 */
"use client";

const KEY = "owner-id";

/** 取匿名 owner id：首次访问生成 uuid 存 localStorage，之后复用。 */
export function getOwnerId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
