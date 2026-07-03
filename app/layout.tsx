import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbmono",
  weight: ["400", "500", "700"],
});
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Argus — Omnipresent Surveillance",
  description:
    "A clean, futuristic 3D-globe geospatial intelligence dashboard streaming live open data.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
