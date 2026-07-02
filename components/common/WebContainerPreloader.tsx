/**
 * [INPUT]: browser page lifecycle after initial render
 * [OUTPUT]: global WebContainer singleton prewarmed after first-screen resources settle
 * [POS]: B 域全局 WebContainer 预热器 —— 延后 boot，供所有预览复用同一个 runtime 实例
 * [PROTOCOL]: 不 mount/install/start，不改变预览状态；失败只记录 warning，真实预览仍由 runPreview 暴露错误。
 */
"use client";

import { useEffect } from "react";

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function afterWindowLoad(callback: () => void) {
  if (document.readyState === "complete") {
    callback();
    return () => undefined;
  }

  window.addEventListener("load", callback, { once: true });
  return () => window.removeEventListener("load", callback);
}

function afterBrowserIdle(callback: () => void) {
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 2500 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, 1200);
  return () => window.clearTimeout(handle);
}

export default function WebContainerPreloader() {
  useEffect(() => {
    let cancelled = false;
    let cancelIdle: () => void = () => undefined;

    const cancelLoad = afterWindowLoad(() => {
      cancelIdle = afterBrowserIdle(() => {
        if (cancelled) return;
        void import("@/lib/webcontainer/runtime")
          .then(({ prewarmWebContainer }) => prewarmWebContainer())
          .catch((error) => {
            console.warn("WebContainer prewarm failed", error);
          });
      });
    });

    return () => {
      cancelled = true;
      cancelLoad();
      cancelIdle();
    };
  }, []);

  return null;
}
