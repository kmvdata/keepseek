import * as vscode from 'vscode';

export type KeepseekLanguage = 'zh-CN' | 'en';

export const DEFAULT_KEEPSEEK_LANGUAGE: KeepseekLanguage = 'zh-CN';

type TranslationValues = Record<string, string | number>;
type TranslationCatalog = Record<string, string>;

export const WEBVIEW_TRANSLATIONS: Record<KeepseekLanguage, TranslationCatalog> = {
  'zh-CN': {
    settings: '设置',
    settingsMenuTitle: '设置',
    settingsApiKeyTitle: 'Api Key',
    settingsApiKeyDescription: '账户 API key 设置',
    settingsLanguageTitle: '语言',
    settingsLanguageDescription: '界面说明和提示语言',
    languageChinese: '中文',
    languageEnglish: 'English',
    languageValueZh: '中文',
    languageValueEn: 'English',
    languageSaved: '语言已切换为 {language}',
    sessionHistory: '历史会话',
    newSession: '新会话',
    startChat: '开始 KeepSeek 对话',
    emptyTranscriptHint: '添加上下文文件后，输入消息并发送',
    pendingEdits: '待确认修改',
    chatInputToolbar: '聊天输入工具栏',
    promptPlaceholder: '描述要构建的内容',
    referenceFile: '引用文件',
    referenceFileTitle: '引用文件 @',
    showCommandMenu: '显示命令菜单',
    showCommandMenuTitle: '显示命令菜单 /',
    send: '发送',
    commandMenu: '命令菜单',
    switchModel: '切换模型...',
    switchModelDescription: '切换 AI 模型',
    modelList: '模型列表',
    effortDescription: '调整生成内容的深度 / 复杂度',
    thinkingDescription: '提升复杂问题的推理质量',
    referenceWorkspaceFiles: '引用工程文件',
    apiDialogLabel: 'DeepSeek API 设置',
    apiDialogTitle: 'DeepSeek API 设置',
    apiDialogDesc: '请输入 DeepSeek 官方申请的 API Key。',
    showApiKey: '显示 API Key',
    hideApiKey: '隐藏 API Key',
    clearApiKey: '清空',
    apiKeyCleared: 'API Key 已清空，点击保存后生效',
    cancel: '取消',
    save: '保存',
    apiSettingsSaved: 'API 设置已保存',
    processing: '处理中...',
    noHistory: '暂无历史会话',
    emptySession: '空会话',
    messageCount: '{count} 条消息',
    insertedFileReference: '已插入文件引用',
    insertedFileReferences: '已插入 {count} 个文件引用',
    referenceFilesTitle: '引用文件',
    loading: '加载中',
    loadingWorkspaceFiles: '正在加载工程文件...',
    noMatchingFiles: '没有匹配的文件',
    noReferenceFiles: '没有可引用的文件',
    chooseExternalFiles: '选择外部文件...',
    chooseExternalFilesDescription: '从工程外选择当前用户可访问的文件',
    importingDroppedFiles: '正在导入拖入文件...',
    droppedFilesTooLarge: '拖入文件过大或无法读取',
    noReferencePath: '未识别到可引用的文件路径',
    droppedFilesUnreadable: '拖入文件无法读取',
    modelSwitched: '已切换模型',
    thinkingOn: 'Thinking 已开启',
    thinkingOff: 'Thinking 已关闭',
    off: 'Off',
    copied: '已复制',
    copyFailed: '复制失败',
    enterContent: '请输入内容',
    copy: '复制',
    editAndResend: '编辑并重发',
    you: '你',
    apply: '应用',
    discard: '丢弃',
    editMessage: '编辑消息',
    fullFileLabel: '全文',
    sendShortcutHint: '按 Ctrl+Enter 或 Command+Enter 发送消息'
  },
  en: {
    settings: 'Settings',
    settingsMenuTitle: 'Settings',
    settingsApiKeyTitle: 'Api Key',
    settingsApiKeyDescription: 'Account API key settings',
    settingsLanguageTitle: 'Language',
    settingsLanguageDescription: 'Language for labels and prompts',
    languageChinese: '中文',
    languageEnglish: 'English',
    languageValueZh: 'Chinese',
    languageValueEn: 'English',
    languageSaved: 'Language changed to {language}',
    sessionHistory: 'Session history',
    newSession: 'New session',
    startChat: 'Start a KeepSeek chat',
    emptyTranscriptHint: 'Add context files, then type and send a message',
    pendingEdits: 'Pending changes',
    chatInputToolbar: 'Chat input toolbar',
    promptPlaceholder: 'Describe what you want to build',
    referenceFile: 'Reference file',
    referenceFileTitle: 'Reference file @',
    showCommandMenu: 'Show command menu',
    showCommandMenuTitle: 'Show command menu /',
    send: 'Send',
    commandMenu: 'Command menu',
    switchModel: 'Switch model...',
    switchModelDescription: 'Switch AI model',
    modelList: 'Model list',
    effortDescription: 'Adjust response depth and complexity',
    thinkingDescription: 'Improve reasoning quality for complex tasks',
    referenceWorkspaceFiles: 'Reference workspace files',
    apiDialogLabel: 'DeepSeek API Settings',
    apiDialogTitle: 'DeepSeek API Settings',
    apiDialogDesc: 'Enter the API Key issued by DeepSeek.',
    showApiKey: 'Show API Key',
    hideApiKey: 'Hide API Key',
    clearApiKey: 'Clear',
    apiKeyCleared: 'API Key cleared. Click Save to apply.',
    cancel: 'Cancel',
    save: 'Save',
    apiSettingsSaved: 'API settings saved',
    processing: 'Processing...',
    noHistory: 'No session history',
    emptySession: 'Empty session',
    messageCount: '{count} messages',
    insertedFileReference: 'Inserted file reference',
    insertedFileReferences: 'Inserted {count} file references',
    referenceFilesTitle: 'Reference files',
    loading: 'Loading',
    loadingWorkspaceFiles: 'Loading workspace files...',
    noMatchingFiles: 'No matching files',
    noReferenceFiles: 'No referenceable files',
    chooseExternalFiles: 'Choose external files...',
    chooseExternalFilesDescription: 'Choose files outside the workspace that your current user can access',
    importingDroppedFiles: 'Importing dropped files...',
    droppedFilesTooLarge: 'Dropped files are too large or unreadable',
    noReferencePath: 'No referenceable file path found',
    droppedFilesUnreadable: 'Dropped files could not be read',
    modelSwitched: 'Model switched',
    thinkingOn: 'Thinking enabled',
    thinkingOff: 'Thinking disabled',
    off: 'Off',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    enterContent: 'Enter a message',
    copy: 'Copy',
    editAndResend: 'Edit and resend',
    you: 'You',
    apply: 'Apply',
    discard: 'Discard',
    editMessage: 'Edit message',
    fullFileLabel: 'full file',
    sendShortcutHint: 'Press Ctrl+Enter or Command+Enter to send'
  }
};

const EXTENSION_TRANSLATIONS: Record<KeepseekLanguage, TranslationCatalog> = {
  'zh-CN': {
    defaultSessionTitle: '新会话',
    addedFile: 'KeepSeek 已添加 {label}。',
    addedWorkspaceFiles: 'KeepSeek 已添加 {count} 个工作区文件。',
    chooseFileToAdd: '请选择要添加到 KeepSeek 上下文的文件。',
    canOnlyInsertExplorerFiles: 'KeepSeek 只能从资源管理器插入文件引用。',
    cannotAddFileReference: 'KeepSeek 无法添加文件引用：{message}',
    addedExternalFiles: 'KeepSeek 已添加 {count} 个外部文件。',
    addExternalFilesLabel: '添加到 KeepSeek',
    canOnlyInsertFileReferencesForFiles: 'KeepSeek 只能为文件插入引用。',
    skippedUnreadableItems: 'KeepSeek 已跳过 {count} 个不是可读文件的项目。',
    cannotAddExternalFileReference: 'KeepSeek 无法添加外部文件引用：{message}',
    skippedDroppedFiles: 'KeepSeek 已跳过 {count} 个过大或无法读取的拖入文件。',
    didNotFindDroppedFiles: 'KeepSeek 未找到任何可读的拖入文件。',
    cannotImportDroppedFile: 'KeepSeek 无法导入拖入文件：{message}',
    apiSettingsSaved: 'DeepSeek API 设置已保存。',
    languageSaved: 'KeepSeek 语言已切换为 {language}。',
    addedFiles: 'KeepSeek 已添加 {count} 个文件。',
    fileReferenceNoPath: '文件引用没有路径。',
    fileReferenceInvalidPath: '文件引用路径无效。',
    cannotOpenFileReference: 'KeepSeek 无法打开文件引用：{message}',
    errorPrefix: '错误',
    wroteFile: '已写入 {label}。',
    noActiveEditor: '未找到活动编辑器。',
    openWorkspaceFirst: '请先打开工作区，再选择工作区文件。',
    selectFilesPlaceholder: '选择要添加到 KeepSeek 上下文的文件',
    addToContextLabel: '添加到 KeepSeek 上下文',
    notRegularFile: '{path} 不是常规文件。',
    largerThanLimit: '{label} 大于 {limit}。',
    appearsBinary: '{label} 似乎是二进制文件。',
    contextAlreadyFull: '上下文已包含 {count} 个文件。',
    enterPath: '请输入文件或文件夹路径。'
  },
  en: {
    defaultSessionTitle: 'New session',
    addedFile: 'KeepSeek added {label}.',
    addedWorkspaceFiles: 'KeepSeek added {count} workspace file(s).',
    chooseFileToAdd: 'Choose a file to add to KeepSeek context.',
    canOnlyInsertExplorerFiles: 'KeepSeek can only insert file references from the Explorer.',
    cannotAddFileReference: 'KeepSeek cannot add file reference: {message}',
    addedExternalFiles: 'KeepSeek added {count} external file(s).',
    addExternalFilesLabel: 'Add to KeepSeek',
    canOnlyInsertFileReferencesForFiles: 'KeepSeek can only insert file references for files.',
    skippedUnreadableItems: 'KeepSeek skipped {count} item(s) that are not readable files.',
    cannotAddExternalFileReference: 'KeepSeek cannot add external file reference: {message}',
    skippedDroppedFiles: 'KeepSeek skipped {count} dropped file(s) that are too large or unreadable.',
    didNotFindDroppedFiles: 'KeepSeek did not find any readable dropped files.',
    cannotImportDroppedFile: 'KeepSeek cannot import dropped file: {message}',
    apiSettingsSaved: 'DeepSeek API settings saved.',
    languageSaved: 'KeepSeek language changed to {language}.',
    addedFiles: 'KeepSeek added {count} file(s).',
    fileReferenceNoPath: 'File reference has no path.',
    fileReferenceInvalidPath: 'File reference path is not valid.',
    cannotOpenFileReference: 'KeepSeek cannot open file reference: {message}',
    errorPrefix: 'Error',
    wroteFile: 'Wrote {label}.',
    noActiveEditor: 'No active editor found.',
    openWorkspaceFirst: 'Open a workspace before picking workspace files.',
    selectFilesPlaceholder: 'Select files to add to KeepSeek context',
    addToContextLabel: 'Add to KeepSeek Context',
    notRegularFile: '{path} is not a regular file.',
    largerThanLimit: '{label} is larger than {limit}.',
    appearsBinary: '{label} appears to be a binary file.',
    contextAlreadyFull: 'Context already contains {count} files.',
    enterPath: 'Enter a file or folder path.'
  }
};

export function normalizeKeepseekLanguage(value: unknown): KeepseekLanguage {
  return value === 'en' ? 'en' : DEFAULT_KEEPSEEK_LANGUAGE;
}

export function getConfiguredKeepseekLanguage(): KeepseekLanguage {
  return normalizeKeepseekLanguage(
    vscode.workspace.getConfiguration('keepseek').get<KeepseekLanguage>('language', DEFAULT_KEEPSEEK_LANGUAGE)
  );
}

export function getKeepseekLanguageName(language: KeepseekLanguage, displayLanguage: KeepseekLanguage = language): string {
  if (language === 'en') {
    return 'English';
  }
  return displayLanguage === 'en' ? 'Chinese' : '中文';
}

export function localize(language: KeepseekLanguage, key: string, values: TranslationValues = {}): string {
  const catalog = EXTENSION_TRANSLATIONS[language] ?? EXTENSION_TRANSLATIONS[DEFAULT_KEEPSEEK_LANGUAGE];
  const fallbackCatalog = EXTENSION_TRANSLATIONS[DEFAULT_KEEPSEEK_LANGUAGE];
  const template = catalog[key] ?? fallbackCatalog[key] ?? key;
  return formatTranslation(template, values);
}

function formatTranslation(template: string, values: TranslationValues): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => String(values[key] ?? ''));
}
