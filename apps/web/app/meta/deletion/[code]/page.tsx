import { cookies } from "next/headers";
import { metaDeletionStatus } from "../../../../../../packages/server/meta-compliance";
import {
  DEFAULT_LOCALE,
  intlLocale,
  isLocale,
  LOCALE_COOKIE,
  translate,
  type MessageKey,
  type Vars,
} from "../../../../i18n/core";

export const dynamic = "force-dynamic";

// Status page linked from Meta's data deletion confirmation.
export default async function MetaDeletionStatus({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  const t = (key: MessageKey, vars?: Vars) => translate(locale, key, vars);
  const request = await metaDeletionStatus(code);
  const when = (value: Date) =>
    new Date(value).toLocaleString(intlLocale(locale), {
      timeZone: "Europe/Budapest",
    });
  return (
    <main className="legal">
      <a href="/legal/privacy">← {t("compliance.privacyLink")}</a>
      <h1>{t("compliance.title")}</h1>
      {request ? (
        <>
          <p className="notice" role="status">
            {t(`compliance.status.${request.status}`)}
          </p>
          <p>{t("compliance.code", { code })}</p>
          <p>{t("compliance.requested", { date: when(request.createdAt) })}</p>
          {request.completedAt && (
            <p>
              {t("compliance.completed", { date: when(request.completedAt) })}
            </p>
          )}
          <p>{t("compliance.scope")}</p>
        </>
      ) : (
        <p className="notice" role="alert">
          {t("compliance.notFound")}
        </p>
      )}
      <p>{t("compliance.contact")}</p>
    </main>
  );
}
