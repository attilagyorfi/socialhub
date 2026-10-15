// Restores the newest daily backup into an empty, temporary database and
// verifies it. Procedure and safety rules: OPERATIONS.md "Restore drill".
import {
  restoreDrillSummary,
  runRestoreDrill,
} from "../packages/server/restore-drill";

const report = await runRestoreDrill();
console.log(JSON.stringify(report));
console.log(restoreDrillSummary(report));
process.exit(report.ok ? 0 : 1);
