import { expandDirectoryReferencesInPrompt, type ExpandDirectoryReferencesOptions } from './directoryReference';
import { expandFileReferencesInPrompt, type ExpandFileReferencesOptions } from './fileReference';

export type ExpandPromptReferencesOptions = ExpandDirectoryReferencesOptions & ExpandFileReferencesOptions;

export async function expandPromptReferencesInPrompt(
  prompt: string,
  options: ExpandPromptReferencesOptions = {}
): Promise<string> {
  const withDirectoryReferences = await expandDirectoryReferencesInPrompt(prompt, options);
  return expandFileReferencesInPrompt(withDirectoryReferences, options);
}
