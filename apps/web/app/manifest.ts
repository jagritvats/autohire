import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest). Icons are built by
// brand/scripts/build_icons.mjs from the outlined mark; see brand/README.md.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JobFlow",
    short_name: "JobFlow",
    description: "A local-first job search engine: jobs ranked against your résumé, with honest match cards.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f1e7",
    theme_color: "#1c1915",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
