import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "G2A Social Hub",
  description:
    "Client workspaces, content approvals and reliable social publishing.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
