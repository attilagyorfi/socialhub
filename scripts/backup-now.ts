// Takes one database backup immediately, regardless of BACKUP_ENABLED and the
// daily schedule; old backups are pruned as usual. See OPERATIONS.md.
import { runDueDatabaseBackup } from "../packages/server/backups";

const backup = await runDueDatabaseBackup(new Date(), { force: true });
console.log(JSON.stringify({ event: "database_backup", ...backup }));
process.exit(0);
