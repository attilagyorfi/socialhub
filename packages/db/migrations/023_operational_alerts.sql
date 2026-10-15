-- Operator alert deduplication: one row per distinct problem (kind + entity).
-- A problem notifies once; when it disappears it is marked resolved, and a
-- later reappearance notifies again.
CREATE TABLE operational_alerts (
 fingerprint text PRIMARY KEY,
 kind text NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 notified_at timestamptz,
 resolved_at timestamptz
);

CREATE INDEX operational_alerts_open_idx
 ON operational_alerts(notified_at)
 WHERE resolved_at IS NULL;
