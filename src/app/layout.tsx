import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Headline to Market",
  description:
    "Turn a news headline into a fair, settleable prediction-market draft — or get an explicit, reasoned rejection.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
