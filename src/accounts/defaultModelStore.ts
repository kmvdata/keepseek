import type * as vscode from 'vscode';
import type { ModelSelection } from '../shared/types';
import { createModelCatalog, findModelBySelection, resolveDefaultModel, toModelSelection } from './modelCatalog';
import type { ModelSource } from './types';

export const GLOBAL_DEFAULT_MODEL_KEY = 'keepseek.defaultModel';

/** One global identity; inferred defaults are never persisted as user choices. */
export class DefaultModelStore {
  private operation: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly globalState: Pick<vscode.Memento, 'get' | 'update'>,
    private readonly listSources: () => Promise<ModelSource[]>
  ) {}

  public refresh() {
    return this.enqueue(async () => {
      const snapshot = await this.readCatalog();
      // Re-read shared state so another window's preference is visible here too.
      const explicitDefault = this.globalState.get<ModelSelection>(GLOBAL_DEFAULT_MODEL_KEY);
      const defaultModel = resolveDefaultModel(snapshot.availableModels, explicitDefault);
      if (explicitDefault && (!explicitDefault.sourceId || !explicitDefault.modelId
        || !findModelBySelection(snapshot.availableModels, explicitDefault))) {
        await this.write(undefined);
      }
      return { ...snapshot, defaultModel };
    });
  }

  public set(selection: ModelSelection) {
    // Copy at dispatch; neither callers nor subsequent refreshes may mutate an
    // in-flight request. Reads also run in this queue, after preceding writes.
    const requested = { ...selection };
    return this.enqueue(async () => {
      const snapshot = await this.readCatalog();
      const model = requested.sourceId && requested.modelId
        ? findModelBySelection(snapshot.availableModels, requested)
        : undefined;
      if (!model?.sourceId || model.agentCompatible === false) {
        throw new Error('The selected default model is unavailable or disabled.');
      }
      const next = toModelSelection({ sourceId: model.sourceId, id: model.id });
      await this.write(next);
      return { ...snapshot, defaultModel: model };
    });
  }

  private async readCatalog() {
    const modelSources = await this.listSources();
    const availableModels = createModelCatalog(modelSources);
    return { modelSources, availableModels };
  }

  private async write(next: ModelSelection | undefined): Promise<void> {
    const previous = this.globalState.get<ModelSelection>(GLOBAL_DEFAULT_MODEL_KEY);
    try {
      await this.globalState.update(GLOBAL_DEFAULT_MODEL_KEY, next);
    } catch (error) {
      // Memento updates its memory before the backing write settles. Restore it
      // on failure so a refresh/retry cannot report an unsaved choice as success.
      // Do not roll back a different choice received from another window.
      if (JSON.stringify(this.globalState.get(GLOBAL_DEFAULT_MODEL_KEY)) === JSON.stringify(next)) {
        await Promise.resolve(this.globalState.update(GLOBAL_DEFAULT_MODEL_KEY, previous)).catch(() => undefined);
      }
      throw error;
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action);
    this.operation = result.catch(() => undefined);
    return result;
  }
}
