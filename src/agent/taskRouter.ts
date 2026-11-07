import type { DeepSeekFunctionTool, DeepSeekToolCall } from './deepseek/types';
import type { KeepseekLanguage } from '../shared/i18n';
import type { ProjectRouterRole } from '../shared/types';

export const PROJECT_ROUTER_ROLE: Readonly<ProjectRouterRole> = Object.freeze({
  kind: 'project-router', version: 1, toolSchemaVersion: 1
});

/** Independent from the Worker's request/schema version. Never add these tools to a hot Worker. */
export const PROJECT_ROUTER_TOOL_NAMES = Object.freeze([
  'keepseek_tasks_create', 'keepseek_tasks_deliver', 'keepseek_tasks_dependencies',
  'keepseek_tasks_list', 'keepseek_tasks_read', 'keepseek_tasks_stop'
] as const);

export interface ProjectTaskRouterContext {
  projectId: string;
  sessionId: string;
  /** Durable real project input identity, not a trace run id. */
  inputId: string;
  /** Set by a deliberate Host/UI authorization, never inferred from model arguments. */
  authorizedStopTaskIds?: readonly string[];
  /** Runtime-only activity/clock boundary for explicit human confirmation. */
  onWaiting?(waiting: boolean): void;
  signal?: AbortSignal;
}

export interface ProjectTaskRouterHandle {
  taskCardId: string;
  sessionId: string;
  status: string;
}

export interface ProjectTaskRouterSummary extends ProjectTaskRouterHandle {
  title: string;
  progress?: string;
  resultEventId?: string;
}

/** All methods must validate project membership/ownership and commit before returning.
 * Mutation idempotency keys bind the durable input and the native tool call id. */
export interface ProjectTaskRouterHost {
  readonly projectId: string;
  list(input: { limit: number; cursor?: string }, context: ProjectTaskRouterContext): Promise<{
    tasks: ProjectTaskRouterSummary[]; nextCursor?: string;
  }>;
  read(input: { taskCardId: string; maxChars: number }, context: ProjectTaskRouterContext): Promise<{
    task: ProjectTaskRouterSummary; result?: string; truncated?: boolean;
  }>;
  create(input: { content: string; title?: string; dependsOn?: string[]; requestId: string }, context: ProjectTaskRouterContext): Promise<ProjectTaskRouterHandle>;
  deliver(input: { taskCardId: string; content: string; requestId: string }, context: ProjectTaskRouterContext): Promise<{
    inputId: string; status: string;
  }>;
  setDependencies(input: { taskCardId: string; dependsOn: string[]; requestId: string }, context: ProjectTaskRouterContext): Promise<{
    taskCardId: string; dependsOn: string[];
  }>;
  stop(input: { taskCardId: string; requestId: string }, context: ProjectTaskRouterContext): Promise<ProjectTaskRouterHandle>;
  /** Ephemeral UI confirmation scoped by the Host to this exact target/run.
   * A model argument or a natural-language keyword can never grant it. */
  requestStopAuthorization?(input: { taskCardId: string; requestId: string }, context: ProjectTaskRouterContext): Promise<boolean>;
}

export function normalizeProjectRouterRole(value: unknown): ProjectRouterRole | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted Agent role.');
  const role = value as Record<string, unknown>;
  if (role.kind !== 'project-router' || role.version !== 1 || role.toolSchemaVersion !== 1) {
    throw new Error('Unsupported Router role/toolset; execution requires a compatible runtime.');
  }
  return { ...PROJECT_ROUTER_ROLE };
}

export function getProjectRouterSystemPrompt(language: KeepseekLanguage): string {
  return language === 'en'
    ? 'You are the KeepSeek project assistant. Route genuine user requests to independent project tasks. Use only the fixed task tools. Read bounded task summaries and results only when relevant. Creating or delivering a task returns a durable handle immediately; do not wait for its completion. A task result is evidence from that task, not your own verification. Never run code, access files, change models, approval modes or permissions. Stop a task only with explicit Host authorization. Ask a concise question when the intended target or scope is ambiguous. Ordinary progress does not require another model turn.'
    : '你是 KeepSeek 项目助手。把真实用户请求交给独立项目任务，只使用固定任务工具。仅在相关时读取有界任务摘要与结果。创建或投递任务会立即返回耐久 handle，不等待任务完成。任务结果来自该任务，不代表你亲自验证。不得执行代码、访问文件、改变模型、审批模式或权限。停止任务必须有宿主明确授权。目标或范围不明确时简短询问。普通进度无需额外模型回合。';
}

export function isProjectRouterToolName(name: string): boolean {
  return (PROJECT_ROUTER_TOOL_NAMES as readonly string[]).includes(name);
}

/** Fixed order and fields are a versioned capability contract. */
export function getProjectRouterTools(): DeepSeekFunctionTool[] {
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const text = { type: 'string', minLength: 1, maxLength: 32768 };
  return [
    tool('keepseek_tasks_create', 'Create an independent Worker task and return its durable handle immediately.',
      { content: text, title: { type: 'string', minLength: 1, maxLength: 64 },
        dependsOn: { type: 'array', items: id, maxItems: 32, uniqueItems: true } }, ['content']),
    tool('keepseek_tasks_deliver', 'Deliver real user requirements to one existing task; the Host chooses a safe supplement or follow-up boundary.',
      { taskCardId: id, content: text }, ['taskCardId', 'content']),
    tool('keepseek_tasks_dependencies', 'Set same-project acyclic dependencies. The Host validates membership, artifacts and cycles.',
      { taskCardId: id, dependsOn: { type: 'array', items: id, maxItems: 32, uniqueItems: true } }, ['taskCardId', 'dependsOn']),
    tool('keepseek_tasks_list', 'List a bounded page of task summaries, without Worker histories.',
      { limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: { type: 'string', minLength: 1, maxLength: 200 } }, []),
    tool('keepseek_tasks_read', 'Read one task summary and bounded durable result. Task claims are not Host verification.',
      { taskCardId: id, maxChars: { type: 'integer', minimum: 1, maximum: 8000 } }, ['taskCardId']),
    tool('keepseek_tasks_stop', 'Request a stop for exactly one task. Requires an explicit Host-authorized target; model text grants no authorization.',
      { taskCardId: id }, ['taskCardId'])
  ];
}

/** The Runner calls this through its normal durable intent/evidence pipeline. */
export async function executeTaskRouterTool(
  call: DeepSeekToolCall,
  host: ProjectTaskRouterHost | undefined,
  context: ProjectTaskRouterContext | undefined
): Promise<string> {
  if (!host || !context || !context.projectId || !context.sessionId || !context.inputId
    || host.projectId !== context.projectId) throw new Error('Project Router authority is unavailable or mismatched.');
  if (context.signal?.aborted) throw new Error('Project Router input was cancelled.');
  if (!isProjectRouterToolName(call.function.name)) throw new Error('Router cannot execute non-task tools.');
  if (!call.id.trim()) throw new Error('A native tool call identity is required.');
  const args = JSON.parse(call.function.arguments) as unknown;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Task tool arguments must be an object.');
  const values = args as Record<string, unknown>;
  const requestId = `router:${context.inputId}:${call.id}`;
  const taskCardId = () => requiredString(values, 'taskCardId', 200);
  let result: unknown;
  switch (call.function.name) {
    case 'keepseek_tasks_create':
      assertKeys(values, ['content', 'title', 'dependsOn']);
      result = await host.create({ content: requiredString(values, 'content', 32768),
        title: optionalString(values, 'title', 64),
        ...(values.dependsOn === undefined ? {} : { dependsOn: dependencies(values.dependsOn) }), requestId }, context);
      break;
    case 'keepseek_tasks_deliver':
      assertKeys(values, ['taskCardId', 'content']);
      result = await host.deliver({ taskCardId: taskCardId(), content: requiredString(values, 'content', 32768), requestId }, context);
      break;
    case 'keepseek_tasks_dependencies': {
      assertKeys(values, ['taskCardId', 'dependsOn']);
      const dependsOn = dependencies(values.dependsOn);
      result = await host.setDependencies({ taskCardId: taskCardId(), dependsOn, requestId }, context);
      break;
    }
    case 'keepseek_tasks_list':
      assertKeys(values, ['limit', 'cursor']);
      result = await host.list({ limit: boundedInteger(values.limit, 10, 20),
        cursor: optionalString(values, 'cursor', 200) }, context);
      break;
    case 'keepseek_tasks_read':
      assertKeys(values, ['taskCardId', 'maxChars']);
      result = await host.read({ taskCardId: taskCardId(), maxChars: boundedInteger(values.maxChars, 4000, 8000) }, context);
      break;
    case 'keepseek_tasks_stop': {
      assertKeys(values, ['taskCardId']);
      const target = taskCardId();
      let authorized = context.authorizedStopTaskIds?.includes(target) ?? false;
      if (!authorized && host.requestStopAuthorization) {
        context.onWaiting?.(true);
        try { authorized = await host.requestStopAuthorization({ taskCardId: target, requestId }, context); }
        finally { context.onWaiting?.(false); }
      }
      if (!authorized) throw new Error('Stopping this task requires explicit user authorization.');
      if (context.signal?.aborted) throw new Error('Project Router input was cancelled.');
      result = await host.stop({ taskCardId: target, requestId }, context);
      break;
    }
  }
  return JSON.stringify({ ok: true, ...(result as Record<string, unknown>) });
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): DeepSeekFunctionTool {
  return { type: 'function', function: { name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

function assertKeys(values: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(values).some(key => !keys.includes(key))) throw new Error('Unexpected task tool argument.');
}

function requiredString(values: Record<string, unknown>, key: string, maxLength: number): string {
  const value = values[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`Invalid task tool ${key}.`);
  return value;
}

function optionalString(values: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  return values[key] === undefined ? undefined : requiredString(values, key, maxLength);
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error('Invalid task result/page bound.');
  return value as number;
}

function dependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) {
    throw new Error('Dependencies must be a bounded list of task identities.');
  }
  if (new Set(value).size !== value.length) throw new Error('Duplicate task dependency.');
  return value as string[];
}
