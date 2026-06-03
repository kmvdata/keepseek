import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ChatSessionStore } from '../sessions/chatSessionStore';
import { getErrorMessage } from '../shared/errors';
import { SafeFileEditor } from './safeFileEditor';
import { DraftEdit } from '../shared/types';

type Translator = (key: string, values?: Record<string, string | number>) => string;

export class DraftEditStore {
  private readonly edits = new Map<string, DraftEdit>();

  public constructor(
    private readonly safeFileEditor: SafeFileEditor,
    private readonly sessionStore: ChatSessionStore,
    private readonly t: Translator
  ) {}

  public addMany(edits: readonly DraftEdit[]): void {
    for (const edit of edits) {
      this.edits.set(edit.id, edit);
    }
  }

  public delete(id: string): void {
    this.edits.delete(id);
  }

  public clear(): void {
    this.edits.clear();
  }

  public toWebviewState(): Array<Omit<DraftEdit, 'newText'>> {
    return Array.from(this.edits.values()).map(({ newText: _newText, ...edit }) => edit);
  }

  public async apply(id: string): Promise<boolean> {
    const edit = this.edits.get(id);
    if (!edit) {
      return false;
    }

    try {
      const applied = await this.safeFileEditor.applyDraftEdit(edit);
      if (applied) {
        this.recordAppliedEdit(edit);
        await this.sessionStore.persist();
      }
      return applied;
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
    }

    return false;
  }

  public async applyAll(): Promise<boolean> {
    const edits = Array.from(this.edits.values());
    if (!edits.length) {
      return false;
    }

    let appliedAny = false;
    for (const edit of edits) {
      if (!this.edits.has(edit.id)) {
        continue;
      }

      try {
        const applied = await this.safeFileEditor.applyDraftEdit(edit);
        if (!applied) {
          continue;
        }

        this.recordAppliedEdit(edit);
        appliedAny = true;
      } catch (error) {
        vscode.window.showErrorMessage(getErrorMessage(error));
      }
    }

    if (appliedAny) {
      await this.sessionStore.persist();
    }
    return appliedAny;
  }

  private recordAppliedEdit(edit: DraftEdit): void {
    this.edits.delete(edit.id);
    this.sessionStore.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: this.t(edit.action === 'delete' ? 'deletedFile' : 'wroteFile', { label: edit.label }),
      createdAt: new Date().toISOString(),
      contextMeta: {
        isProtected: true,
        protectedReason: 'draft_edit_result'
      }
    });
    this.sessionStore.getActiveSession().updatedAt = new Date().toISOString();
  }
}
