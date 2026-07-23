/**
 * [INPUT]: project UUID、default branch、Browser Repository Worker client
 * [OUTPUT]: 已显式 provision 且完成 git init 的 BrowserGitProjectRepository
 * [POS]: B 域 Browser Git local-first provisioning —— 服务端项目落库前建立唯一源码来源
 * [PROTOCOL]: provision 幂等；普通 adapter open 不创建缺失仓库；init 成功后调用方才可创建服务端项目
 */
import {
  BrowserRepositoryCommandType,
  BrowserRepositoryResultSchema,
} from "../../types/browserRepositoryProtocol";
import type { BrowserGitProjectRepository } from "../../types/browserGitRepository";
import { ProjectStorageKind } from "../../types/projectStorage";
import { createBrowserGitProjectRepository } from "./browser";
import type { BrowserGitWorkerClient } from "./browserGitWorkerClient";

type ProvisionBrowserGitProjectRepositoryInput = {
  client: BrowserGitWorkerClient;
  projectId: string;
  defaultBranch: string;
};

export async function provisionBrowserGitProjectRepository({
  client,
  projectId,
  defaultBranch,
}: ProvisionBrowserGitProjectRepositoryInput): Promise<BrowserGitProjectRepository> {
  const provisioned = BrowserRepositoryResultSchema.provision_repository.parse(
    await client.execute({
      type: BrowserRepositoryCommandType.Provision,
      projectId,
      initialRevision: 0,
    }),
  );
  const repository = createBrowserGitProjectRepository({
    descriptor: {
      projectId,
      storageKind: ProjectStorageKind.BrowserGit,
      revision: provisioned.revision,
    },
    client,
  });
  await repository.initGit({ defaultBranch });
  return repository;
}
