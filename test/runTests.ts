import './builtinGenPrompt.test';
import './genPromptTurn.test';
import './handoffPrompt.test';
import './planHandoffFaults.test';
import './planExecutionProbe.test';
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
import './sessionMenuHover.test';
import './sessionQuarantine.test';
import './sessionAbsentTombstone.test';
import './subagentProfileCapability.test';
import { after } from 'node:test';

// The provider's startup schedules interval timers; a completed run must not
// hang waiting for them to be collected.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });
