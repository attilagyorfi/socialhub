import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  translate,
  type MessageKey,
} from "../../../i18n/core";

type Section = { title: MessageKey; body: MessageKey };
type LegalPage = { title: MessageKey; sections: Section[] };

const pages: Record<string, LegalPage> = {
  privacy: {
    title: "legal.title.privacy",
    sections: [
      { title: "legal.privacy.s1.title", body: "legal.privacy.s1.body" },
      { title: "legal.privacy.s2.title", body: "legal.privacy.s2.body" },
      { title: "legal.privacy.s3.title", body: "legal.privacy.s3.body" },
      { title: "legal.privacy.s4.title", body: "legal.privacy.s4.body" },
      { title: "legal.privacy.s5.title", body: "legal.privacy.s5.body" },
      { title: "legal.privacy.s6.title", body: "legal.privacy.s6.body" },
      { title: "legal.privacy.s7.title", body: "legal.privacy.s7.body" },
      { title: "legal.privacy.s8.title", body: "legal.privacy.s8.body" },
      { title: "legal.privacy.s9.title", body: "legal.privacy.s9.body" },
      { title: "legal.privacy.s10.title", body: "legal.privacy.s10.body" },
      { title: "legal.privacy.s11.title", body: "legal.privacy.s11.body" },
      { title: "legal.privacy.s12.title", body: "legal.privacy.s12.body" },
      { title: "legal.privacy.s13.title", body: "legal.privacy.s13.body" },
    ],
  },
  terms: {
    title: "legal.title.terms",
    sections: [
      { title: "legal.terms.s1.title", body: "legal.terms.s1.body" },
      { title: "legal.terms.s2.title", body: "legal.terms.s2.body" },
      { title: "legal.terms.s3.title", body: "legal.terms.s3.body" },
      { title: "legal.terms.s4.title", body: "legal.terms.s4.body" },
      { title: "legal.terms.s5.title", body: "legal.terms.s5.body" },
      { title: "legal.terms.s6.title", body: "legal.terms.s6.body" },
      { title: "legal.terms.s7.title", body: "legal.terms.s7.body" },
      { title: "legal.terms.s8.title", body: "legal.terms.s8.body" },
      { title: "legal.terms.s9.title", body: "legal.terms.s9.body" },
      { title: "legal.terms.s10.title", body: "legal.terms.s10.body" },
      { title: "legal.terms.s11.title", body: "legal.terms.s11.body" },
      { title: "legal.terms.s12.title", body: "legal.terms.s12.body" },
    ],
  },
  deletion: {
    title: "legal.title.deletion",
    sections: [
      { title: "legal.deletion.s1.title", body: "legal.deletion.s1.body" },
      { title: "legal.deletion.s2.title", body: "legal.deletion.s2.body" },
      { title: "legal.deletion.s3.title", body: "legal.deletion.s3.body" },
      { title: "legal.deletion.s4.title", body: "legal.deletion.s4.body" },
      { title: "legal.deletion.s5.title", body: "legal.deletion.s5.body" },
      { title: "legal.deletion.s6.title", body: "legal.deletion.s6.body" },
    ],
  },
};

const BULLET = "• ";

// Plain-text body → paragraphs ("\n\n") and lists (consecutive "• " lines).
function renderBody(text: string) {
  return text.split("\n\n").flatMap((block, b) => {
    const nodes: ReactNode[] = [];
    let items: string[] = [];
    let lines: string[] = [];
    const flushItems = () => {
      if (items.length)
        nodes.push(
          <ul key={`${b}-ul-${nodes.length}`}>
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>,
        );
      items = [];
    };
    const flushLines = () => {
      if (lines.length)
        nodes.push(<p key={`${b}-p-${nodes.length}`}>{lines.join(" ")}</p>);
      lines = [];
    };
    for (const line of block.split("\n")) {
      if (line.startsWith(BULLET)) {
        flushLines();
        items.push(line.slice(BULLET.length));
      } else {
        flushItems();
        lines.push(line);
      }
    }
    flushLines();
    flushItems();
    return nodes;
  });
}

export default async function Legal({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const slug = (await params).page;
  if (!Object.hasOwn(pages, slug)) notFound();
  const page = pages[slug];
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  const t = (key: MessageKey) => translate(locale, key);
  return (
    <main className="legal" lang={locale}>
      <a href="/">← G2A Social Hub</a>
      <h1>{t(page.title)}</h1>
      <p className="notice">{t("legal.draftNotice")}</p>
      <p className="legal-updated">{t("legal.lastUpdated")}</p>
      {page.sections.map((section) => (
        <section key={section.title}>
          <h2>{t(section.title)}</h2>
          {renderBody(t(section.body))}
        </section>
      ))}
    </main>
  );
}
