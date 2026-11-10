// Serialize connection changes from different tabs/devices for the same account.
// Generation remains concurrent and is stopped by login/disconnect operations.
const mutations = new Map<string, Promise<unknown>>();

export async function withCliMutation<T>(userId: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(userId);
  const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(action);
  mutations.set(userId, pending);
  try { return await pending; }
  finally { if (mutations.get(userId) === pending) mutations.delete(userId); }
}
