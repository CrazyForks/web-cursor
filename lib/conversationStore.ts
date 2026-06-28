"use client";

import { create } from "zustand";

type ConversationState = {
  busy: boolean;
  writing: boolean;
  activeAiId: string;
  activityText: string;
  startTurn: (aiId: string) => void;
  setActivity: (text: string) => void;
  setWriting: (writing: boolean) => void;
  finishTurn: () => void;
  stopTurn: () => void;
};

export const useConversationStore = create<ConversationState>((set) => ({
  busy: false,
  writing: false,
  activeAiId: "",
  activityText: "",
  startTurn: (activeAiId) => set({
    activeAiId,
    busy: true,
    writing: true,
    activityText: "正在生成…",
  }),
  setActivity: (activityText) => set({ activityText }),
  setWriting: (writing) => set({ writing }),
  finishTurn: () => set({ busy: false, writing: false, activityText: "" }),
  stopTurn: () => set({ busy: false, writing: false, activityText: "已停止" }),
}));
