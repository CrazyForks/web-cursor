/**
 * [INPUT]: Workbench route 的 initialProjectId、React children 与 selector
 * [OUTPUT]: 当前 Workbench 实例私有的 ProjectRuntime store context、selector hook 与 store API hook
 * [POS]: B 域 route-scoped project runtime 注入边界；每个 Provider 实例只创建一个 vanilla store
 * [PROTOCOL]: 禁止模块级项目 store；路由项目变化由 store action 或 Provider 实例边界表达。
 */
"use client";

import {
  createContext,
  type PropsWithChildren,
  useContext,
  useRef,
} from "react";
import { useStore } from "zustand";
import {
  createProjectRuntimeStore,
  type ProjectRuntimeState,
  type ProjectRuntimeStoreApi,
} from "@/lib/projectRuntimeStore";

const ProjectRuntimeStoreContext = createContext<ProjectRuntimeStoreApi | null>(null);

type ProjectRuntimeProviderProps = PropsWithChildren<{
  initialProjectId?: string;
}>;

export function ProjectRuntimeProvider({
  initialProjectId,
  children,
}: ProjectRuntimeProviderProps) {
  const storeRef = useRef<ProjectRuntimeStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createProjectRuntimeStore(initialProjectId);
  }

  return (
    <ProjectRuntimeStoreContext.Provider value={storeRef.current}>
      {children}
    </ProjectRuntimeStoreContext.Provider>
  );
}

export function useProjectRuntimeStoreApi(): ProjectRuntimeStoreApi {
  const store = useContext(ProjectRuntimeStoreContext);
  if (!store) {
    throw new Error("useProjectRuntimeStoreApi must be used within ProjectRuntimeProvider");
  }
  return store;
}

export function useProjectRuntime<T>(selector: (state: ProjectRuntimeState) => T): T {
  return useStore(useProjectRuntimeStoreApi(), selector);
}
