/**
 * [INPUT]: 无
 * [OUTPUT]: 稳定的匿名 owner id 字符串
 * [POS]: B 域身份门面 —— owner 状态由 Zustand store 持有，供 api.ts / streamChat 带上 x-owner-id
 * [PROTOCOL]: 非鉴权，仅数据隔离；换设备 / 清缓存 = 新身份。后端只读取、不校验格式
 */
"use client";

import { useOwnerStore } from "@/lib/ownerStore";

export function getOwnerId(): string {
  return useOwnerStore.getState().getOwnerId();
}
