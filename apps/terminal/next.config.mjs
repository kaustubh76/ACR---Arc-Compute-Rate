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
      /* A third redirect lived here until 2026-10-09: www -> apex for the
       * custom domain, so that one host would be canonical.
       *
       * REMOVED BECAUSE IT WAS DEAD IN BOTH DIRECTIONS. Its `has` matched the
       * Host header against `www.<custom domain>`, which cannot match a request
       * to the Vercel alias — so it never fired for real traffic — and that
       * hostname never reached Vercel's edge anyway, because the domain's DNS
       * was never moved off Hostinger's parking. Zero invocations, zero value.
       *
       * Worse than useless, in fact: had the DNS later been half-fixed — www
       * pointed at Vercel, apex not — this rule would have taken the one host
       * that worked and redirected it to a parked page. Dead config that only
       * becomes wrong is still a liability.
       *
       * The canonical host now lives in exactly the places that are checked
       * against each other by `tests/test_canonical_host.py`, and nowhere else.
       */
    ];
  },
};

export default nextConfig;
