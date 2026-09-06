import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Floor & Ceiling | Model monitoring",
  description: "Weekly monitoring for player outcome forecast ranges.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
