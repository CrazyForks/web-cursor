/**
 * [INPUT]: strict BrowserRepositoryCommand values from a Browser Git repository adapter
 * [OUTPUT]: correlated Worker results or typed ProjectRepositoryError failures
 * [POS]: B 域主线程 ↔ Browser Repository Worker 的消息桥
 * [PROTOCOL]: every request/response is strict parsed and correlated by UUID; dispose rejects pending work
 */
import {
  BrowserRepositoryRequestSchema,
  BrowserRepositoryResponseSchema,
  type BrowserRepositoryCommand,
} from "../../types/browserRepositoryProtocol";
import {
  ProjectRepositoryError,
  ProjectRepositoryErrorCode,
} from "../../types/projectRepository";

export interface BrowserGitWorkerClient {
  execute(command: BrowserRepositoryCommand): Promise<unknown>;
  dispose(): void;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

export function createBrowserGitWorkerClient(): BrowserGitWorkerClient {
  const worker = new Worker(new URL("./browserGitWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  function rejectAll(error: ProjectRepositoryError): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const parsed = BrowserRepositoryResponseSchema.safeParse(event.data);
    if (!parsed.success) {
      rejectAll(new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        `invalid Browser Repository Worker response: ${parsed.error.message}`,
      ));
      return;
    }
    const response = parsed.data;
    const request = pending.get(response.id);
    if (!request) {
      rejectAll(new ProjectRepositoryError(
        ProjectRepositoryErrorCode.ProtocolViolation,
        `Worker response has no pending request: ${response.id}`,
      ));
      return;
    }
    pending.delete(response.id);
    if (response.ok) {
      request.resolve(response.result);
    } else {
      request.reject(new ProjectRepositoryError(response.error.code, response.error.message));
    }
  });

  worker.addEventListener("error", (event) => {
    rejectAll(new ProjectRepositoryError(
      ProjectRepositoryErrorCode.InternalError,
      event.message || "Browser Repository Worker crashed",
    ));
  });

  return {
    execute(command) {
      if (disposed) {
        return Promise.reject(new ProjectRepositoryError(
          ProjectRepositoryErrorCode.WorkerDisposed,
          "Browser Repository Worker client is disposed",
        ));
      }
      const request = BrowserRepositoryRequestSchema.parse({
        id: crypto.randomUUID(),
        command,
      });
      return new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        worker.postMessage(request);
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      worker.terminate();
      rejectAll(new ProjectRepositoryError(
        ProjectRepositoryErrorCode.WorkerDisposed,
        "Browser Repository Worker client was disposed",
      ));
    },
  };
}
