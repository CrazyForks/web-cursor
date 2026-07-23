/**
 * [INPUT]: transaction runner、Database→Browser Git CAS update、当前项目状态读取
 * [OUTPUT]: 已激活项目行，或可区分的 not-found/storage/revision conflict
 * [POS]: A 域项目存储迁移事务核心 —— 保证 source revision 未变化时才切换唯一写源
 * [PROTOCOL]: activate 与 inspect 必须使用同一 transaction context；不做字段兜底或内容验证猜测
 */
import { ProjectStorageKind, type ProjectStorageKind as ProjectStorageKindValue } from "../types/projectStorage";

export const ProjectStorageMigrationErrorCode = {
  NotFound: "PROJECT_NOT_FOUND",
  StorageConflict: "PROJECT_STORAGE_CONFLICT",
  RevisionConflict: "PROJECT_REVISION_CONFLICT",
  ActivationFailed: "PROJECT_STORAGE_ACTIVATION_FAILED",
} as const;

export type ProjectStorageMigrationErrorCode =
  typeof ProjectStorageMigrationErrorCode[keyof typeof ProjectStorageMigrationErrorCode];

export class ProjectStorageMigrationError extends Error {
  constructor(
    readonly code: ProjectStorageMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectStorageMigrationError";
  }
}

type CurrentProjectStorage = {
  storageKind: ProjectStorageKindValue;
  revision: number;
};

type ExecuteProjectStorageMigrationInput<TContext, TProject> = {
  sourceRevision: number;
  transaction: (operation: (context: TContext) => Promise<TProject>) => Promise<TProject>;
  activate: (context: TContext) => Promise<TProject | null>;
  inspectCurrent: (context: TContext) => Promise<CurrentProjectStorage | null>;
};

export async function executeProjectStorageMigration<TContext, TProject>({
  sourceRevision,
  transaction,
  activate,
  inspectCurrent,
}: ExecuteProjectStorageMigrationInput<TContext, TProject>): Promise<TProject> {
  return transaction(async (context) => {
    const activated = await activate(context);
    if (activated) return activated;

    const current = await inspectCurrent(context);
    if (!current) {
      throw new ProjectStorageMigrationError(
        ProjectStorageMigrationErrorCode.NotFound,
        "Project does not exist or is deleted.",
      );
    }
    if (current.storageKind !== ProjectStorageKind.Database) {
      throw new ProjectStorageMigrationError(
        ProjectStorageMigrationErrorCode.StorageConflict,
        `Project storage is ${current.storageKind}; expected ${ProjectStorageKind.Database}.`,
      );
    }
    if (current.revision !== sourceRevision) {
      throw new ProjectStorageMigrationError(
        ProjectStorageMigrationErrorCode.RevisionConflict,
        `Project revision is ${current.revision}; expected ${sourceRevision}.`,
      );
    }
    throw new ProjectStorageMigrationError(
      ProjectStorageMigrationErrorCode.ActivationFailed,
      "Project storage activation failed despite a matching source state.",
    );
  });
}
