"use client";

import { create } from "zustand";

const OWNER_ID_KEY = "owner-id";

type OwnerState = {
  ownerId: string | null;
  getOwnerId: () => string;
};

function readStoredOwnerId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(OWNER_ID_KEY);
}

function createOwnerId() {
  const ownerId = crypto.randomUUID();
  window.localStorage.setItem(OWNER_ID_KEY, ownerId);
  return ownerId;
}

export const useOwnerStore = create<OwnerState>((set, get) => ({
  ownerId: readStoredOwnerId(),
  getOwnerId: () => {
    const current = get().ownerId ?? readStoredOwnerId();
    if (current) {
      if (get().ownerId !== current) set({ ownerId: current });
      return current;
    }

    const ownerId = createOwnerId();
    set({ ownerId });
    return ownerId;
  },
}));
