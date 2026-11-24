import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db";
import {
  effectiveBrandRules,
  type SyncedBrandProfile,
} from "../core/brand-guardrails";
import { AppError } from "../core/security";
import type { ApiKeyContext } from "./api-keys";
import { canonical } from "./api-v1-posts";
import { audit, transaction } from "./transaction";
import { uuid } from "./validation";

export const brandSyncLimits = {
  voice: 2000,
  phrases: 100,
  phrase: 200,
  disclaimer: 1000,
  pillars: 20,
  pillarName: 120,
  pillarDescription: 1000,
} as const;

export const brandSyncSource = "growth_engine";

// Trimmed, without blanks and case-insensitive duplicates (the guardrails
// match case-insensitively), sorted so the order does not change the hash.
function uniqueSorted(items: string[]) {
  const seen = new Set<string>();
  return items
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLocaleLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort();
}

const phrases = z
  .array(z.string().max(brandSyncLimits.phrase))
  .max(brandSyncLimits.phrases)
  .default([])
  .transform(uniqueSorted);

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => value?.trim() || null);

// Contract body of PUT /api/v1/clients/{id}/brand-profile. The PUT replaces
// the whole synced profile: an omitted field is stored empty. Unknown keys are
// rejected so a typo cannot silently drop a rule.
export const syncedBrandInput = z.strictObject({
  voice: optionalText(brandSyncLimits.voice),
  required_phrases: phrases,
  forbidden_phrases: phrases,
  required_disclaimer: optionalText(brandSyncLimits.disclaimer),
  pillars: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(brandSyncLimits.pillarName),
        description: optionalText(brandSyncLimits.pillarDescription),
      }),
    )
    .max(brandSyncLimits.pillars)
    .default([])
    // Pillar order is kept; a repeated name keeps its first occurrence.
    .transform((pillars) => {
      const seen = new Set<string>();
      return pillars.filter((pillar) => {
        const key = pillar.name.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }),
});

export const syncedBrandHash = (profile: SyncedBrandProfile) =>
  createHash("sha256").update(canonical(profile)).digest("hex");

const clientNotFound = () =>
  new AppError(404, "NOT_FOUND", "Client not found.");

function validationError(error: z.ZodError) {
  return new AppError(
    400,
    "VALIDATION",
    error.issues
      .slice(0, 10)
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join(" "),
  );
}

const iso = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();

const fields = Object.keys(
  syncedBrandInput.shape,
) as (keyof SyncedBrandProfile)[];

// PUT /api/v1/clients/{id}/brand-profile. Writes only the synced_* columns:
// the local `profile` and its updated_at are never touched. The hash check and
// the write share one transaction and a row lock, so repeating the same body
// (even concurrently) writes and audits once and returns the same reply.
export async function putSyncedBrandProfile(
  key: ApiKeyContext,
  clientId: string,
  body: unknown,
) {
  const parsed = syncedBrandInput.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  const profile = parsed.data;
  if (!uuid.safeParse(clientId).success) throw clientNotFound();
  const hash = syncedBrandHash(profile);

  return transaction(async (tx) => {
    const client = await tx.query(
      "SELECT 1 FROM clients WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL",
      [key.organizationId, clientId],
    );
    if (!client.rows.length) throw clientNotFound();
    await tx.query(
      `INSERT INTO brand_profiles(organization_id,client_id) VALUES($1,$2)
       ON CONFLICT(client_id) DO NOTHING`,
      [key.organizationId, clientId],
    );
    let row = (
      await tx.query(
        `SELECT synced_profile,synced_at,synced_source,synced_hash FROM brand_profiles
         WHERE organization_id=$1 AND client_id=$2 FOR UPDATE`,
        [key.organizationId, clientId],
      )
    ).rows[0];
    if (row.synced_hash !== hash) {
      const previous = row.synced_profile as SyncedBrandProfile | null;
      const previousHash = (row.synced_hash as string | null) ?? null;
      row = (
        await tx.query(
          `UPDATE brand_profiles SET synced_profile=$1,synced_at=now(),synced_source=$2,
             synced_by_api_key_id=$3,synced_hash=$4
           WHERE organization_id=$5 AND client_id=$6
           RETURNING synced_profile,synced_at,synced_source`,
          [
            JSON.stringify(profile),
            brandSyncSource,
            key.keyId,
            hash,
            key.organizationId,
            clientId,
          ],
        )
      ).rows[0];
      await audit(
        tx,
        { organizationId: key.organizationId, clientId, userId: null },
        "brand.synced",
        clientId,
        {
          source: "api",
          api_key_id: key.keyId,
          previous_hash: previousHash,
          hash,
          changed_fields: fields.filter(
            (field) =>
              canonical(previous?.[field] ?? null) !==
              canonical(profile[field]),
          ),
        },
      );
    }
    return {
      client_id: clientId,
      ...(row.synced_profile as SyncedBrandProfile),
      synced_source: row.synced_source,
      synced_at: iso(row.synced_at),
    };
  });
}

// The brand rules in force for a client (local supplement + synced profile),
// read inside the caller's transaction when one is given.
export async function loadEffectiveBrand(
  db: Pick<PoolClient, "query"> | typeof pool,
  organizationId: string,
  clientId: string,
) {
  const row = (
    await db.query(
      "SELECT profile,synced_profile FROM brand_profiles WHERE organization_id=$1 AND client_id=$2",
      [organizationId, clientId],
    )
  ).rows[0];
  return effectiveBrandRules(row?.profile, row?.synced_profile);
}
