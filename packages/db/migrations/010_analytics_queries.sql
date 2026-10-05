CREATE INDEX analytics_daily_scope_day_idx
 ON analytics_daily(organization_id,client_id,day,social_account_id);

CREATE INDEX post_metrics_scope_target_captured_idx
 ON post_metrics(organization_id,client_id,target_id,captured_at DESC);

CREATE INDEX post_targets_published_idx
 ON post_targets(organization_id,client_id,published_at DESC)
 WHERE status='PUBLISHED';
