import type { Metadata } from "next";
import { StaffAuthProvider } from "@/components/StaffAuthProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Al Haq Farms Management",
  description: "Secure staff order management for Al Haq Farms.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <StaffAuthProvider>{children}</StaffAuthProvider>
      </body>
    </html>
  );
}
