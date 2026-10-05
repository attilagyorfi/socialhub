CREATE TABLE ai_generations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 user_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
 post_id uuid,
 operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 40),
 provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 160),
 mode text NOT NULL CHECK(mode IN ('mock','live')),
 status text NOT NULL CHECK(status IN ('PENDING','COMPLETE','FAILED')),
 input text NOT NULL,
 output text,
 brand_snapshot jsonb NOT NULL DEFAULT '{}',
 guardrail_result jsonb,
 prompt_tokens integer CHECK(prompt_tokens IS NULL OR prompt_tokens >= 0),
 completion_tokens integer CHECK(completion_tokens IS NULL OR completion_tokens >= 0),
 total_tokens integer CHECK(total_tokens IS NULL OR total_tokens >= 0),
 estimated_cost_micros bigint CHECK(estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
 error_code text,
 applied_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(organization_id,client_id,id),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,post_id) REFERENCES posts(organization_id,client_id,id) ON DELETE CASCADE
);

CREATE INDEX ai_generations_scope_created_idx
 ON ai_generations(organization_id,client_id,created_at DESC);

CREATE INDEX ai_generations_user_created_idx
 ON ai_generations(user_id,created_at DESC);
