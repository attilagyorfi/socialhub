import { readinessSnapshot } from "../../../../../../packages/server/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await readinessSnapshot();
  return Response.json(snapshot, {
    status: snapshot.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
