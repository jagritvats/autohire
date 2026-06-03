/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // workspace packages are TS source — let Next transpile them
  transpilePackages: [
    "@jobflow/core",
    "@jobflow/adapters",
    "@jobflow/db",
    "@jobflow/llm",
    "@jobflow/pipeline",
    "@jobflow/autofill",
  ],
  experimental: {
    externalDir: true,
  },
  webpack: (config) => {
    // workspace packages import with ESM ".js" specifiers that point at ".ts"
    // source — let webpack resolve .js → .ts/.tsx (then fall back to real .js).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
