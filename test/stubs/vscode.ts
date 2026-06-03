export const workspace = {
  workspaceFolders: [],
  workspaceFile: undefined,
  name: 'KeepSeek Test Workspace',
  getConfiguration() {
    return {
      get<T>(_key: string, fallback: T): T {
        return fallback;
      },
      async update(): Promise<void> {
        return undefined;
      }
    };
  }
};

export const ConfigurationTarget = {
  Global: 1
};
