import { getConfiguredKeepseekLanguage, localize } from '../shared/i18n';

export type BinaryImageErrorCode = 'imageWriteFailed' | 'imageWriteInvalidMetadata' | 'imageWriteUnsupportedTarget'
  | 'imageWriteVisualConfirmation' | 'imageWriteBackupUnavailable' | 'imageWriteConflict'
  | 'imageWriteExtensionMismatch' | 'imageWritePreviewQuota' | 'imageWriteOtherSession'
  | 'imageWriteInvalidImage' | 'imageWriteTooLarge' | 'imageWriteCancelled';

/** UI-safe localized summary; diagnostics remain separate from the public message. */
export class BinaryImageDraftError extends Error {
  public constructor(public readonly code: BinaryImageErrorCode, public readonly detail?: string) {
    super(localize(getConfiguredKeepseekLanguage(), code));
    this.name = 'BinaryImageDraftError';
  }
}
