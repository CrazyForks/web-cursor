"use client";

import { create } from "zustand";

export type WorkbenchViewMode = "preview" | "code";

type WorkbenchState = {
  viewMode: WorkbenchViewMode;
  setViewMode: (mode: WorkbenchViewMode) => void;
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  viewMode: "code",
  setViewMode: (viewMode) => set({ viewMode }),
}));
