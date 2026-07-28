/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Circle Gateway SDK (viem, EIP-3009 signing) is a Node package used only
  // by the server-side buyer/balances routes — keep it external so Next bundles
  // it as a plain Node dependency (not traced/bundled for the server chunk).
  // (Next 14 spelling; `serverExternalPackages` in Next 15.)
  experimental: {
    serverComponentsExternalPackages: ["@circle-fin/x402-batching"],
  },
};

export default nextConfig;
