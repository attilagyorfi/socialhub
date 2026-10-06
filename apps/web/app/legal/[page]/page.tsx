import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  translate,
  type MessageKey,
} from "../../../i18n/core";

const titles: Record<string, MessageKey> = {
  privacy: "legal.title.privacy",
  terms: "legal.title.terms",
  deletion: "legal.title.deletion",
};

export default async function Legal({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const page = (await params).page;
  if (!titles[page]) notFound();
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  const t = (key: MessageKey) => translate(locale, key);
  return (
    <main className="legal">
      <a href="/">← G2A Social Hub</a>
      <h1>{t(titles[page])}</h1>
      <p className="notice">{t("legal.draftNotice")}</p>
      {page === "deletion" ? (
        <>
          <p>{t("legal.deletion.user")}</p>
          <p>{t("legal.deletion.organization")}</p>
        </>
      ) : (
        <p>{t("legal.placeholder")}</p>
      )}
    </main>
  );
}
