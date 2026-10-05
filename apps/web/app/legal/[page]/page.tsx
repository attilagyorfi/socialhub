import { notFound } from "next/navigation";
export default async function Legal({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const page = (await params).page;
  const titles: Record<string, string> = {
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    deletion: "Data deletion instructions",
  };
  if (!titles[page]) notFound();
  return (
    <main className="legal">
      <a href="/">← G2A Social Hub</a>
      <h1>{titles[page]}</h1>
      <p className="notice">
        Draft information. Professional legal review is required before
        production launch.
      </p>
      {page === "deletion" ? (
        <>
          <p>
            Signed-in users can download their personal data and request account
            deletion under Settings → Privacy and data retention. Account
            deletion begins after a 24-hour grace period and can be cancelled
            before processing. A sole organization owner must first transfer
            ownership or delete the organization.
          </p>
          <p>
            Organization owners can request deletion from the same screen. Live
            social-provider connections must be disconnected and revoked first.
            Organization deletion begins after a 72-hour grace period, removes
            tenant records and stored media, and can be cancelled before
            processing.
          </p>
        </>
      ) : (
        <p>
          This page is a placeholder, not a legal guarantee. The production
          operator must publish the controller identity, lawful bases, retention
          periods, subprocessors, international transfer arrangements,
          data-subject contact details and applicable contractual terms before
          collecting production data.
        </p>
      )}
    </main>
  );
}
