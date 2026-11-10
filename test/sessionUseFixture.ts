/** For Host-only fixtures without a storage backend. Storage and race tests use
 * the real ChatSessionStore and SessionDeletionAuthority instead. */
export function sessionUseFixture() {
  return {
    assertSessionWritable: async () => {},
    acquireSessionUse: async () => ({ release: async () => {} })
  };
}
