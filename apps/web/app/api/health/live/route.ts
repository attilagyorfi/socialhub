export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      revision: process.env.APP_REVISION || undefined,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
