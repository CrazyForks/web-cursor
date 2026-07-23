/**
 * [INPUT]: transaction runner、revision claim、同 transaction context 的 file mutation
 * [OUTPUT]: mutation value + 已提交的新 project revision，或原样抛出 conflict/mutation error
 * [POS]: A 域 Database 文件 CAS 编排器 —— 保证 revision 与文件 mutation 同成同败
 * [PROTOCOL]: 必须先 claim 再 mutate；任一步抛错都交给 transaction runner 回滚
 */
export type RevisionedMutationResult<TValue> = {
  value: TValue;
  revision: number;
};

type RevisionedMutationInput<TContext, TValue> = {
  transaction: (
    operation: (context: TContext) => Promise<RevisionedMutationResult<TValue>>,
  ) => Promise<RevisionedMutationResult<TValue>>;
  claimRevision: (context: TContext) => Promise<number | null>;
  mutate: (context: TContext) => Promise<TValue>;
  revisionConflict: () => Error;
};

/**
 * Claims the next project revision before mutating files inside one transaction.
 * A failed claim never invokes the mutation; a thrown mutation lets the transaction roll back both changes.
 */
export async function executeRevisionedMutation<TContext, TValue>({
  transaction,
  claimRevision,
  mutate,
  revisionConflict,
}: RevisionedMutationInput<TContext, TValue>): Promise<RevisionedMutationResult<TValue>> {
  return transaction(async (context) => {
    const revision = await claimRevision(context);
    if (revision === null) throw revisionConflict();

    const value = await mutate(context);
    return { value, revision };
  });
}
