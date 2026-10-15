// Restores the newest daily backup into an empty, temporary database and
// verifies it. Procedure and safety rules: OPERATIONS.md "Restore drill".
import {
  restoreDrillSummary,
  runRestoreDrill,
} from "../packages/server/restore-drill";

const report = await runRestoreDrill();
// Exit only after stdout is flushed: piped output is written asynchronously,
// and open storage/database sockets would otherwise keep the process alive.
process.stdout.write(
  `${JSON.stringify(report)}
${restoreDrillSummary(report)}
`,
  () => process.exit(report.ok ? 0 : 1),
);
