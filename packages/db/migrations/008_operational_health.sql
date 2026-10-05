CREATE TABLE service_heartbeats (
 service_name text NOT NULL CHECK(length(service_name) BETWEEN 1 AND 80),
 instance_id text NOT NULL CHECK(length(instance_id) BETWEEN 1 AND 200),
 started_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(service_name,instance_id)
);

CREATE INDEX service_heartbeats_freshness_idx
 ON service_heartbeats(service_name,last_seen_at DESC);
