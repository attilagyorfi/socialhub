import type { Metadata } from "next";
import { cookies } from "next/headers";
import { I18nProvider } from "../i18n";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "../i18n/core";
import "./globals.css";
export const metadata: Metadata = {
  title: "G2A Social Hub",
  description:
    "Client workspaces, content approvals and reliable social publishing.",
};
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The signed-in user's saved language replaces this once the hub loads.
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  return (
    <html lang={locale}>
      <body>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
