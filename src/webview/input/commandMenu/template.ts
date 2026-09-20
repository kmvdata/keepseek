import type { WebviewFragment } from '../composition';

export const commandMenuTemplateFragment: WebviewFragment = {
  id: 'template.command-menu',
  source: `
        <div id="commandMenu" class="command-menu hidden" role="menu" aria-label="命令菜单" data-i18n-aria-label="commandMenu">
          <div class="command-menu-header">
            <span class="command-menu-title" data-i18n="commandMenu">命令菜单</span>
          </div>

          <section class="command-section" aria-label="Skills">
            <div class="command-section-label">Skills</div>
            <div class="command-skills-row">
              <button
                id="commandSkillsMainButton"
                type="button"
                class="command-skills-main-button"
                role="menuitem"
                aria-expanded="false"
                aria-controls="commandSkillList"
              >
                <span class="command-row-main">
                  <span class="command-row-title" data-i18n="skillsCommandTitle">使用 Skills</span>
                  <span class="command-row-description" data-i18n="skillsDescription">输入 $ 快捷调出 Skills 选择器</span>
                </span>
              </button>
              <span class="command-skills-actions">
                <span id="commandSkillFilterControl" class="command-skill-filter-control hidden">
                  <input
                    id="commandSkillFilterInput"
                    class="command-skill-filter-input"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="按名称筛选 Skills"
                    data-i18n-placeholder="skillsFilterPlaceholder"
                    aria-label="按名称筛选 Skills"
                    data-i18n-aria-label="skillsFilterLabel"
                    disabled
                  />
                  <button
                    id="commandSkillFilterButton"
                    type="button"
                    class="command-skill-icon-button command-skill-filter-button"
                    role="menuitem"
                    aria-label="筛选 Skills"
                    data-i18n-aria-label="skillsFilter"
                    title="筛选 Skills"
                    data-i18n-title="skillsFilter"
                    aria-expanded="false"
                    aria-controls="commandSkillFilterInput commandSkillList"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.75 4h10.5L9.25 8.5v3.25l-2.5 1.25V8.5L2.75 4Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                    </svg>
                  </button>
                </span>
                <button
                  id="commandCreateSkillButton"
                  type="button"
                  class="command-skill-icon-button command-skill-create-button hidden"
                  role="menuitem"
                  aria-label="创建 Skill"
                  data-i18n-aria-label="createSkill"
                  title="创建 Skill"
                  data-i18n-title="createSkill"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
                  </svg>
                </button>
                <button
                  id="commandSkillsButton"
                  type="button"
                  class="command-skill-icon-button command-skills-toggle-button"
                  role="menuitem"
                  aria-expanded="false"
                  aria-controls="commandSkillList"
                  aria-label="展开 Skills 列表"
                  data-i18n-aria-label="skillsExpand"
                  title="展开 Skills 列表"
                  data-i18n-title="skillsExpand"
                >
                  <span class="command-skills-chevron" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 16 16">
                      <path d="m6 3.75 4.25 4.25L6 12.25" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </span>
                </button>
              </span>
            </div>
            <div id="commandSkillList" class="command-skill-list hidden" role="group" aria-label="Skills 列表" data-i18n-aria-label="skillsList"></div>
          </section>

          <section id="commandLegacyMemorySection" class="command-section hidden" aria-label="Legacy memory migration" data-i18n-aria-label="legacyMemoryMigration">
            <div class="command-section-label" data-i18n="legacyMemoryMigration">Legacy migration</div>
            <button id="commandLegacyMemoryMigrateButton" type="button" class="command-row" role="menuitem">
              <span class="command-row-main">
                <span class="command-row-title">/migrate-legacy-memory</span>
                <span class="command-row-description" data-i18n="legacyMemoryMigrationDescription">生成 AGENTS.md / Skill 待确认修改</span>
              </span>
              <span id="commandLegacyMemoryValue" class="command-row-value"></span>
            </button>
            <button id="commandLegacyMemoryExportButton" type="button" class="command-row" role="menuitem">
              <span class="command-row-main">
                <span class="command-row-title">/export-legacy-memory</span>
                <span class="command-row-description" data-i18n="legacyMemoryExportDescription">复制只读迁移导出</span>
              </span>
            </button>
            <button id="commandLegacyMemoryCompleteButton" type="button" class="command-row hidden" role="menuitem">
              <span class="command-row-main">
                <span class="command-row-title">/complete-memory-migration</span>
                <span class="command-row-description" data-i18n="legacyMemoryCompleteDescription">确认迁移并停止旧记忆注入</span>
              </span>
            </button>
            <button id="commandLegacyMemoryRollbackButton" type="button" class="command-row hidden" role="menuitem">
              <span class="command-row-main">
                <span class="command-row-title">/rollback-memory-migration</span>
                <span class="command-row-description" data-i18n="legacyMemoryRollbackDescription">重置迁移状态；旧文件仍保留，可再次导出</span>
              </span>
            </button>
          </section>

          <section id="commandBackgroundRunSection" class="command-section hidden" aria-label="Background task" data-i18n-aria-label="backgroundRun">
            <div class="command-section-label">Agent</div>
            <button
              id="commandBackgroundRunButton"
              type="button"
              class="command-row"
              role="menuitem"
            >
              <span class="command-row-main">
                <span class="command-row-title">/background-run</span>
                <span class="command-row-description" data-i18n="backgroundCommandDescription">有限轮验证与修复，修改仍需审核</span>
              </span>
              <span id="commandBackgroundRunValue" class="command-row-value"></span>
            </button>
          </section>

          <section class="command-section" aria-label="Model">
            <div class="command-section-label">Model</div>
            <button
              id="commandModelSwitch"
              type="button"
              class="command-row"
              role="menuitem"
              aria-expanded="false"
              aria-controls="commandModelList"
            >
              <span class="command-row-main">
                <span class="command-row-title" data-i18n="switchModel">主模型</span>
                <span id="commandModelDescription" class="command-row-description" data-i18n="switchModelDescription">切换当前项目的主模型</span>
              </span>
              <span id="commandModelValue" class="command-row-value command-model-current">DeepSeek-V4-Flash</span>
            </button>
            <div id="commandModelList" class="command-model-list hidden" role="group" aria-label="模型列表" data-i18n-aria-label="modelList"></div>
            <div id="commandModelStatus" class="command-model-status hidden" role="status" aria-live="polite">
              <span id="commandModelStatusText"></span>
              <button id="commandModelCancelPending" type="button" class="command-model-cancel hidden" data-i18n="cancelPendingModel">取消待切换</button>
            </div>
            <button
              id="commandSubagentModelSwitch"
              type="button"
              class="command-row"
              role="menuitem"
              aria-expanded="false"
              aria-controls="commandSubagentModelList"
            >
              <span class="command-row-main">
                <span class="command-row-title" data-i18n="subagentModelTitle">子代理模型</span>
                <span id="commandSubagentModelDescription" class="command-row-description" data-i18n="subagentModelHint">默认跟随主模型，可为当前项目单独选择</span>
              </span>
              <span id="commandSubagentModelValue" class="command-row-value command-model-current" data-i18n="subagentProfileModelScope">按子代理类型选择模型</span>
            </button>
            <div id="commandSubagentModelList" class="command-subagent-profile-list hidden" role="group" aria-label="子代理模型" data-i18n-aria-label="subagentModelTitle"></div>
            <button
              id="commandApprovalModeSwitch"
              type="button"
              class="command-row"
              role="menuitem"
              aria-expanded="false"
            >
              <span class="command-row-main">
                <span class="command-row-title" data-i18n="approvalMode">审批模式</span>
                <span id="commandApprovalModeDescription" class="command-row-description" data-i18n="approvalModeDescription">为当前项目选择写入文件和运行命令的审批方式</span>
              </span>
              <span id="commandApprovalModeValue" class="command-row-value command-model-current" data-i18n="approvalAsk">请求批准</span>
            </button>
            <div id="commandApprovalModeList" class="command-model-list hidden" role="group" aria-label="审批模式" data-i18n-aria-label="approvalMode"></div>
            <div class="command-control-row command-compression-row">
              <span class="command-row-main">
                <span class="command-row-title" data-i18n="compressionThreshold">自动压缩阈值</span>
                <span
                  id="commandCompressionDescription"
                  class="command-row-description"
                  role="tabpanel"
                  aria-labelledby="commandCompressionBalanced"
                  data-i18n="compressionBalancedDescription"
                >80% 触发，平衡上下文空间与前缀缓存</span>
              </span>
              <div
                id="commandCompressionTabs"
                class="command-compression-tabs"
                role="tablist"
                aria-label="自动压缩阈值"
                data-i18n-aria-label="compressionThreshold"
                aria-describedby="commandCompressionDescription"
              >
                <button
                  id="commandCompressionAggressive"
                  type="button"
                  class="command-compression-tab"
                  role="tab"
                  data-threshold="aggressive"
                  data-i18n="compressionEarlyTab"
                  aria-selected="false"
                  aria-controls="commandCompressionDescription"
                >70%（提前清理）</button>
                <button
                  id="commandCompressionBalanced"
                  type="button"
                  class="command-compression-tab"
                  role="tab"
                  data-threshold="balanced"
                  data-i18n="compressionBalancedTab"
                  aria-selected="true"
                  aria-controls="commandCompressionDescription"
                >80%（平衡）</button>
                <button
                  id="commandCompressionCache"
                  type="button"
                  class="command-compression-tab"
                  role="tab"
                  data-threshold="cache"
                  data-i18n="compressionCacheFirstTab"
                  aria-selected="false"
                  aria-controls="commandCompressionDescription"
                >85%（缓存优先）</button>
              </div>
            </div>
          </section>

          <section class="command-section" aria-label="Reasoning">
            <label class="command-control-row" for="commandEffortSlider">
              <span class="command-row-main">
                <span class="command-row-title">Effort (<span id="commandEffortValue">High</span>)</span>
                <span class="command-row-description" data-i18n="effortDescription">控制深度思考的开关与强度</span>
              </span>
              <span class="command-effort-control">
                <input
                  id="commandEffortSlider"
                  class="command-effort-slider"
                  type="range"
                  min="0"
                  max="2"
                  step="1"
                  value="1"
                  aria-label="Effort"
                  aria-valuetext="High"
                />
                <span class="command-effort-scale" aria-hidden="true">
                  <span>Off</span>
                  <span>High</span>
                  <span>Max</span>
                </span>
              </span>
            </label>
          </section>
        </div>
`.slice(1)
};
