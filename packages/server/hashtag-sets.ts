import type { z } from "zod";
import type { Context } from "./context";
import { pool } from "../db";
import { audit, transaction } from "./transaction";
import { AppError } from "../core/security";
import type { hashtagSetInput } from "./validation";

// Every query is scoped to the context's organization and client, so a set
// of another organization's client is never visible or writable (404).
type Input = z.infer<typeof hashtagSetInput>;

export async function listHashtagSets(c: Context) {
  return (
    await pool.query(
      "SELECT id,name,hashtags,updated_at FROM client_hashtag_sets WHERE organization_id=$1 AND client_id=$2 ORDER BY lower(name)",
      [c.organizationId, c.clientId],
    )
  ).rows as { id: string; name: string; hashtags: string[] }[];
}

const duplicateName = () =>
  new AppError(
    409,
    "HASHTAG_SET_EXISTS",
    "This client already has a hashtag set with this name.",
  );

export async function saveHashtagSet(c: Context, input: Input, id?: string) {
  return transaction(async (tx) => {
    const client = (
      await tx.query(
        "SELECT id FROM clients WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL",
        [c.clientId, c.organizationId],
      )
    ).rows[0];
    if (!client) throw new AppError(404, "NOT_FOUND", "Client not found.");
    const taken = (
      await tx.query(
        "SELECT 1 FROM client_hashtag_sets WHERE organization_id=$1 AND client_id=$2 AND lower(name)=lower($3) AND id IS DISTINCT FROM $4",
        [c.organizationId, c.clientId, input.name, id ?? null],
      )
    ).rows[0];
    if (taken) throw duplicateName();
    const row = (
      id
        ? await tx.query(
            "UPDATE client_hashtag_sets SET name=$1,hashtags=$2,updated_at=now() WHERE id=$3 AND organization_id=$4 AND client_id=$5 RETURNING id,name,hashtags",
            [input.name, input.hashtags, id, c.organizationId, c.clientId],
          )
        : await tx.query(
            "INSERT INTO client_hashtag_sets(organization_id,client_id,name,hashtags) VALUES($1,$2,$3,$4) RETURNING id,name,hashtags",
            [c.organizationId, c.clientId, input.name, input.hashtags],
          )
    ).rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "Hashtag set not found.");
    await audit(
      tx,
      c,
      id ? "hashtag_set.updated" : "hashtag_set.created",
      row.id,
    );
    return row as { id: string; name: string; hashtags: string[] };
  });
}

export async function deleteHashtagSet(c: Context, id: string) {
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        "DELETE FROM client_hashtag_sets WHERE id=$1 AND organization_id=$2 AND client_id=$3 RETURNING id",
        [id, c.organizationId, c.clientId],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "Hashtag set not found.");
    await audit(tx, c, "hashtag_set.deleted", id);
    return { id };
  });
}
