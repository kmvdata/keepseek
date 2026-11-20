import './approveAllExecution.test';
import './changeSetBatchAdmission.test';
import './sessionStartupStorageContracts.test';
import './sessionMissingRecordShapes.test';
import './startupContextFailure.test';
import './accountEditorStartupFailure.test';
import './sessionQuarantine.test';
import './sessionAbsentTombstone.test';
import { after } from 'node:test';

// The provider's startup schedules interval timers; a completed run must not
// hang waiting for them to be collected.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });
