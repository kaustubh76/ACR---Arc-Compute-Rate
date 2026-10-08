/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Circle Gateway SDK (viem, EIP-3009 signing) is a Node package used only
  // by the server-side buyer/balances routes — keep it external so Next bundles
  // it as a plain Node dependency (not traced/bundled for the server chunk).
  //
  // RENAMED, and it was silently inert before. This sat under
  // `experimental.serverComponentsExternalPackages`, which THIS Next version does
  // not recognise: every build printed "Unrecognized key(s) in object:
  // 'serverComponentsExternalPackages' at experimental" and carried on, so the
  // comment above described a directive that was not being applied. A config key
  // that moved is the quietest kind of breakage — the build still succeeds.
  serverExternalPackages: ["@circle-fin/x402-batching"],

  /* Two routes were removed and their links did not go with them.
   *
   * `/sellers` (the registry page) and `/exchange` (folded into /curve as the
   * shop floor) are named by thirteen documentation sites, and FIVE of those are
   * executable steps rather than prose: docs/COMMUNITY-TEST.md:20 is step 2 of
   * the public tester script, docs/MAINNET_RUNBOOK.md:118 is step 7,
   * docs/TESTNET_RUNBOOK.md:217 is a checkpoint, and docs/agent-runbook.md names
   * it twice. There were no redirects or rewrites in this project at all, so
   * every one of those resolved to app/not-found.tsx.
   *
   * Six lines fixes all of them at once — including the frozen `hackathon/` tree,
   * which is explicitly not edited, and any reviewer's bookmark, which cannot be
   * edited at all. Editing twelve documents would not have reached either.
   *
   * `permanent: false` (307) rather than 308, deliberately: a permanent redirect
   * is cached by the browser indefinitely, and these are a product decision that
   * could be revisited. A 307 costs one request and can be taken back.
   *
   * `/sellers` goes to the register on /developers rather than to the page root,
   * because the register IS what /sellers was for — and `RegistryProof` sits
   * directly beneath it, which is the one control that page uniquely had.
   */
  async redirects() {
    return [
      { source: "/exchange", destination: "/curve", permanent: false },
      { source: "/sellers", destination: "/developers#register", permanent: false },
      /* www -> apex, so one host is canonical and the other sends you to it.
       *
       * HERE RATHER THAN IN VERCEL'S DOMAIN SETTINGS, which can also do this.
       * A dashboard redirect is invisible from the repository, untestable in
       * CI, and lost the next time somebody re-creates the project — and this
       * file already carries the reasoning for the other two redirects, so a
       * reader finds all three in one place. It costs one function invocation
       * on a path almost nobody takes.
       *
       * `has` matches the Host header, so this fires only for www and leaves
       * the apex and the still-live `arc-compute-rate.vercel.app` alone. The
       * `:path*` capture keeps the deep link: www.../curve lands on /curve,
       * not the homepage, which is the difference between a redirect and a
       * dead end.
       *
       * 307 to match the other two: this is a product decision about which
       * host is canonical, and a 308 is cached by the browser indefinitely.
       */
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.arccomputerate.in" }],
        destination: "https://arccomputerate.in/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
