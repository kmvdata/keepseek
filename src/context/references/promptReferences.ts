import { expandDirectoryReferencesInPrompt, type ExpandDirectoryReferencesOptions } from './directoryReference';
import { expandFileReferencesInPrompt, type ExpandFileReferencesOptions } from './fileReference';
import { expandSkillReferencesInPrompt, type ExpandSkillReferencesOptions } from './skillReference';

export type ExpandPromptReferencesOptions = ExpandDirectoryReferencesOptions & ExpandFileReferencesOptions & ExpandSkillReferencesOptions;

export async function expandPromptReferencesInPrompt(
  prompt: string,
  options: ExpandPromptReferencesOptions = {}
): Promise<string> {
  const withDirectoryReferences = await expandDirectoryReferencesInPrompt(prompt, options);
  const withFileReferences = await expandFileReferencesInPrompt(withDirectoryReferences, options);
  return expandSkillReferencesInPrompt(withFileReferences, options);
}
