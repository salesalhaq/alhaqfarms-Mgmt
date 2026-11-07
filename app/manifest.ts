import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Al Haq Farms & Meats Management",
    short_name: "Al Haq Farms",
    description: "Pure.Fresh.Perfected.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7f5",
    theme_color: "#1b7748",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
