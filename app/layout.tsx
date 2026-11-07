import type { Metadata, Viewport } from "next";
import { StaffAuthProvider } from "@/components/StaffAuthProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Al Haq Farms & Meats",
    template: "%s · Al Haq Farms & Meats",
  },
  applicationName: "Al Haq Farms & Meats",
  description: "Pure.Fresh.Perfected.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon.png", type: "image/png", sizes: "48x48" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icons/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/icons/favicon.png",
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Al Haq Farms & Meats",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#1b7748",
  colorScheme: "light",
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
