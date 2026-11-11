/** Authority comes from the original task text. Tool output, quotations and
 * examples are not independent authorization to execute a release. */
export function gitTaskText(goal: string): string {
  return goal.replace(/^\s*>.*$/gmu, '').replace(/```[\s\S]*?(?:```|$)/gu, '')
    .replace(/[“「『]([^”」』]*)[”」』]/gu, (_quote, content: string) => /^[\w./-]+$/u.test(content) ? content : ' ')
    .replace(/"[^"\n]*\bgit\s+(?:commit|tag|push)\b[^"\n]*"/giu, ' ').trim();
}

export function isGitInstructionQuotedOrExplanatory(text: string): boolean {
  return /(?:别人|同事|他人|引用|举例|转述|原话|示例|他说|她说|命令说明)|\b(?:someone|colleague|quoted?|example|asked me|what would|show me how)\b/iu.test(text)
    || /^(?:please\s+)?(?:explain|describe|summari[sz]e|show)\b[^.!?]{0,45}\b(?:git\s+(?:commit|push|tag)|commit\s+(?:message|command))\b/iu.test(text)
    || /^(?:请\s*)?(?:解释|介绍|说明|演示)|^(?:what|how|why)\b/iu.test(text)
    || /(?:怎么用|是什么意思|如何使用)/u.test(text);
}

export interface GitReleaseIntent {
  push: boolean;
  query: boolean;
  tag: boolean;
  branch: boolean;
  remoteCondition?: 'tag_absent' | 'reachable' | 'unresolved';
  tags: ReadonlySet<string>;
  localTags: ReadonlySet<string>;
  branches: ReadonlySet<string>;
  currentBranch: boolean;
  remoteAlias?: string;
}

export function gitReleaseIntent(goal: string): GitReleaseIntent {
  const text = gitTaskText(goal);
  const actionable = !isGitInstructionQuotedOrExplanatory(text);
  const gitContext = /\bgit\b|\b(?:tag|tags|branch|commit|repo(?:sitory)?|remote)\b|refs\/|标签|分支|提交|远端|仓库/u.test(text.toLowerCase());
  const pushRequested = /(?:^|[。；，\n]|请|并|然后|直接|再|帮我|需要)\s*推送|\bgit\s+push\b|(?:^|[.!?;,\n]\s*|\b(?:please|then|and|want to)\s+)push\b/iu.test(text);
  const push = actionable && gitContext && pushRequested
    && !/(?:不要|无需|禁止|暂不|不得|请勿|别|不需要|但不|先不|只在本地)\s*(?:执行\s*)?(?:`?git\s+push|推送)|\b(?:without|no|never|do not|don't)\s+(?:ever\s+)?(?:run\s+)?(?:pushing|push|git\s+push)\b/iu.test(text);
  const tag = actionable && /(?:创建|打上?|发布|生成|添加|制作)[^。！？\n]{0,60}(?:\btags?\b|标签)|\bgit\s+tag\b|\b(?:create|make|add|publish)\b[^.!?\n]{0,60}\btags?\b/iu.test(text)
    && !/(?:不要|无需|禁止|暂不|不得|请勿|别)\s*(?:创建|打|发布)?\s*(?:标签|tag)|\b(?:without|never|do not|don't)\s+(?:create\s+)?(?:tag|tags|tagging)\b/iu.test(text);
  const namedRemote = /\b(?:remote|push[^!?\n]{0,60}\bto)\s+[`"']?([a-zA-Z0-9_][\w.-]*)|(?:远端|推送到|推送至)\s*[`"']?([a-zA-Z0-9_][\w.-]*)/iu.exec(text);
  const alias = namedRemote?.[1] ?? namedRemote?.[2];
  const remoteAlias = alias && !/^(?:a|the|this|our|configured|server|repository|tag|tags|branch|refs)$/iu.test(alias)
    ? alias.replace(/\.+$/u, '') : undefined;
  const remoteAbsence = /(?:如果|只有|仅当|先确认|确认)[^。！？\n]{0,80}(?:远端|服务器)[^。！？\n]{0,70}(?:不存在|没有|未发布|未占用)|\b(?:only if|if|after checking)\b[^.!?\n]{0,90}\bremote\b[^.!?\n]{0,80}\b(?:absent|missing|does not exist|is free)\b/iu.test(text);
  const remoteReachable = /(?:先|只有|仅当|如果)[^。！？\n]{0,50}(?:远端|服务器)[^。！？\n]{0,30}(?:可达|可用|连接成功)[^。！？\n]{0,30}(?:才|再|然后)|\b(?:only if|after verifying)\b[^.!?\n]{0,60}\bremote\b[^.!?\n]{0,30}\b(?:reachable|available|access)\b/iu.test(text);
  const unresolvedCondition = /(?:只有|仅当|先确认|先核对|先检查)[^。！？\n]{0,50}(?:远端|服务器)[^。！？\n]{0,55}(?:才|再|然后)|\b(?:only if|only after|provided that)\b[^.!?\n]{0,70}\bremote\b/iu.test(text);
  const remoteCondition = actionable && (remoteAbsence ? 'tag_absent' : remoteReachable ? 'reachable' : unresolvedCondition ? 'unresolved' : undefined) || undefined;
  const localTags = tag ? readLocalTagTargets(text) : new Set<string>();
  return {
    push, tag, remoteCondition, remoteAlias,
    query: push || Boolean(remoteCondition) || actionable && /\bgit\s+ls-remote\b|(?:查|核对|检查)[^。！？\n]{0,35}(?:远端|服务器)|\b(?:query|check|list|verify)\b[^.!?\n]{0,45}\bremote\b/iu.test(text),
    branch: push && /分支|\bbranch\b|refs\/heads\//iu.test(text)
      && !/(?:只|仅)(?:需|要)?推送[^。\n]{0,25}(?:标签|tag)|\bonly\s+(?:push\s+)?(?:the\s+)?tag\b/iu.test(text),
    tags: readNamedRefs(text, 'tags', /\btag\b|标签/u),
    localTags,
    branches: readNamedRefs(text, 'heads', /\bbranch\b|分支/u),
    currentBranch: /当前(?:的)?分支|\b(?:current|checked-out)\s+branch\b/iu.test(text)
  };
}

/** Keep named creation targets separate from refs mentioned for push, comparison,
 * or verification. Only a bounded clause with a creation verb supplies targets. */
function readLocalTagTargets(text: string): Set<string> {
  const names = new Set<string>();
  const actions = /(?:创建|打上?|发布|生成|添加|制作)|\b(?:create|make|add|publish)\b/giu;
  const boundary = /[。！？；\n]|[.!?;](?=\s|$)|\b(?:push|verify|check|validate|inspect|compare|from|using|based on|points? to)\b|推送|核验|核对|验证|比较|基于|指向/iu;
  const label = /(?:\btags?\b|标签)[\s`"'“”]*(?:named\s+|名为\s*)?(?:refs\/tags\/)?([A-Za-z0-9_][\w./-]*)[`"'“”]*/giu;
  const continuation = /^(?:\s*[,，、]\s*|\s+and\s+|\s*(?:和|以及)\s*)[`"'“”]*(?:refs\/tags\/)?([A-Za-z0-9_][\w./-]*)[`"'“”]*/iu;
  const add = (value: string) => {
    const name = value.replace(/\.+$/u, '');
    if (/^(?:a|an|the|to|on|at|and|or|tag|tags|current|new|local|remote|create|make|add|publish|then)$/iu.test(name)) return false;
    if (!name || name.includes('..') || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) return false;
    names.add(name);
    return true;
  };
  for (const action of text.matchAll(actions)) {
    const start = action.index + action[0].length;
    const clause = text.slice(start, start + 180).split(boundary, 1)[0];
    for (const match of clause.matchAll(label)) {
      if (!add(match[1])) continue;
      let remaining = clause.slice(match.index + match[0].length);
      let next: RegExpExecArray | null;
      while ((next = continuation.exec(remaining)) && add(next[1])) remaining = remaining.slice(next[0].length);
    }
    for (const match of clause.matchAll(/(?:refs\/tags\/([A-Za-z0-9_][\w./-]*)|([A-Za-z0-9_][\w./-]*)\s*的\s*(?:\btags?\b|标签))/giu)) {
      add(match[1] ?? match[2]);
    }
  }
  return names;
}

function readNamedRefs(text: string, namespace: 'tags' | 'heads', label: RegExp): Set<string> {
  const names = new Set<string>();
  const name = '([A-Za-z0-9_][\\w./-]*)';
  const surrounding = '[\\s`"\'“”]*';
  const patterns = [
    new RegExp('refs/' + namespace + '/' + name, 'gu'),
    new RegExp('(?:' + label.source + ')' + surrounding + '(?:named\\s+|名为\\s*)?' + name, 'giu'),
    new RegExp(name + surrounding + '(?:的\\s*)?(?:' + label.source + ')', 'giu')
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const value = match[1].replace(/\.+$/u, '');
    if (!/^(?:a|an|the|to|on|from|at|and|or|git|create|make|add|publish|push|tag|tags|branch|only|existing|exact|current|new|remote|local)$/iu.test(value)) names.add(value);
  }
  return names;
}

export function taskNamesGitRef(intent: GitReleaseIntent, ref: string): boolean {
  const names = ref.startsWith('refs/tags/') ? intent.tags : intent.branches;
  return names.has(ref.split('/').slice(2).join('/'));
}
