/** Shape only a newly produced listing, before it is sent or journaled. Never
 * rewrite a historical tool result: its exact bytes belong to the cache prefix. */
export function shapeWorkspaceListingResult(parsed: Record<string, unknown>, underPressure: boolean): string {
  const raw = JSON.stringify(parsed);
  const key = Array.isArray(parsed.files) ? 'files' : Array.isArray(parsed.entries) ? 'entries' : undefined;
  if (parsed.ok !== true || !key) return raw;
  const entries = parsed[key] as unknown[];
  const limit = underPressure ? 50 : 100;
  const charLimit = underPressure ? 6_000 : 12_000;
  if (entries.length <= limit && raw.length <= charLimit) return raw;

  const result = {
    ...parsed,
    [key]: [] as unknown[],
    count: 0,
    totalListed: entries.length,
    truncated: true,
    limit: Math.min(typeof parsed.limit === 'number' ? parsed.limit : limit, limit),
    hint: 'Partial listing. Use keepseek_list_workspace_directory with a specific path and maxFiles, or keepseek_search_workspace with a scoped path/query; do not repeat the full workspace listing.'
  };
  const selected = result[key] as unknown[];
  // Reserve space for the wrapper as well as individual entries; a very long
  // path must not consume the whole run's tool-result budget on its own.
  let chars = JSON.stringify(result).length + 8;
  for (const entry of entries) {
    const entryChars = JSON.stringify(entry).length + 1;
    if (selected.length >= limit || chars + entryChars > charLimit) break;
    selected.push(entry);
    chars += entryChars;
  }
  result.count = selected.length;
  return JSON.stringify(result);
}
