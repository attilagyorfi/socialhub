import type { PoolClient } from "pg";
import type { z } from "zod";
import type { Context } from "./context";
import { pool } from "../db";
import { audit, transaction } from "./transaction";
import { AppError } from "../core/security";
import { REPLY_TEMPLATE_LIMIT } from "../core/reply-templates";
import type { replyTemplateInput } from "./validation";

// Every query is scoped to the context's organization and client, so a
// template of another organization's client is never visible or writable (404).
type Input = z.infer<typeof replyTemplateInput>;
export type ReplyTemplate = { id: string; name: string; body: string };

export async function listReplyTemplates(c: Context) {
  return (
    await pool.query(
      "SELECT id,name,body FROM client_reply_templates WHERE organization_id=$1 AND client_id=$2 ORDER BY lower(name)",
      [c.organizationId, c.clientId],
    )
  ).rows as ReplyTemplate[];
}

const duplicateName = () =>
  new AppError(
    409,
    "REPLY_TEMPLATE_EXISTS",
    "This client already has a reply template with this name.",
  );
const notFound = () =>
  new AppError(404, "NOT_FOUND", "Reply template not found.");

export async function saveReplyTemplate(c: Context, input: Input, id?: string) {
  try {
    return await transaction((tx) => save(tx, c, input, id));
  } catch (error) {
    // The unique index has the last word on names.
    if ((error as { code?: unknown } | null)?.code === "23505")
      throw duplicateName();
    throw error;
  }
}

async function save(tx: PoolClient, c: Context, input: Input, id?: string) {
  const scope = [c.organizationId, c.clientId];
  // Concurrent saves of one client wait here, so neither the limit nor the
  // name check can be passed by two requests at once.
  const client = (
    await tx.query(
      "SELECT id FROM clients WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
      scope,
    )
  ).rows[0];
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found.");
  if (id) {
    const existing = await tx.query(
      "SELECT 1 FROM client_reply_templates WHERE organization_id=$1 AND client_id=$2 AND id=$3",
      [...scope, id],
    );
    if (!existing.rows[0]) throw notFound();
  }
  const taken = await tx.query(
    "SELECT 1 FROM client_reply_templates WHERE organization_id=$1 AND client_id=$2 AND lower(name)=lower($3) AND id IS DISTINCT FROM $4",
    [...scope, input.name, id ?? null],
  );
  if (taken.rows[0]) throw duplicateName();
  if (!id) {
    const { count } = (
      await tx.query(
        "SELECT count(*)::int AS count FROM client_reply_templates WHERE organization_id=$1 AND client_id=$2",
        scope,
      )
    ).rows[0];
    if (count >= REPLY_TEMPLATE_LIMIT)
      throw new AppError(
        409,
        "REPLY_TEMPLATE_LIMIT",
        `A client can have at most ${REPLY_TEMPLATE_LIMIT} reply templates.`,
      );
  }
  const row = (
    id
      ? await tx.query(
          "UPDATE client_reply_templates SET name=$3,body=$4,updated_at=now() WHERE organization_id=$1 AND client_id=$2 AND id=$5 RETURNING id,name,body",
          [...scope, input.name, input.body, id],
        )
      : await tx.query(
          "INSERT INTO client_reply_templates(organization_id,client_id,name,body) VALUES($1,$2,$3,$4) RETURNING id,name,body",
          [...scope, input.name, input.body],
        )
  ).rows[0];
  if (!row) throw notFound();
  await audit(
    tx,
    c,
    id ? "reply_template.updated" : "reply_template.created",
    row.id,
  );
  return row as ReplyTemplate;
}

export async function deleteReplyTemplate(c: Context, id: string) {
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        "DELETE FROM client_reply_templates WHERE id=$1 AND organization_id=$2 AND client_id=$3 RETURNING id",
        [id, c.organizationId, c.clientId],
      )
    ).rows[0];
    if (!row) throw notFound();
    await audit(tx, c, "reply_template.deleted", id);
    return { id };
  });
}
