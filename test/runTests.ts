import './builtinGenPrompt.test';
import './genPromptTurn.test';
import './handoffGuardCorpus.test';
import './approveAllExecution.test';
import './approveAllBoundary.test';
import './validationAuthorization.test';
import './validationBarrier.test';
import './activityNodes.test';
import './commandCapabilityGrammar.test';
import './runValidationReconciliation.test';
import './changeSetBatchAdmission.test';
import './sessionStartupStorageContracts.test';
import './sessionMissingRecordShapes.test';
import './startupContextFailure.test';
import './accountEditorStartupFailure.test';
import './sessionMenuToggle.test';
import './sessionQuarantine.test';
import './sessionAbsentTombstone.test';
import './subagentProfileCapability.test';
import './protectedTargetPolicy.test';
import './writeLease.test';
import './sessionObjectGc.test';
import './sessionOpenLazy.test';
import './composerReadinessGate.test';
import './webviewHelperResolution.test';
import './sessionHistoryOrderAndStatus.test';
import { after } from 'node:test';

// The provider's startup schedules interval timers; a completed run must not
// hang waiting for them to be collected.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });
