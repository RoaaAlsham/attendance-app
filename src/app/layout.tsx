import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QR Attendance",
  description: "Lecture attendance via a QR code that rotates every 10 seconds.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
