/** CLI configuration for the ACR buyer agent. */

export interface AgentConfig {
  /** Index API base URL. */
  api: string;
  /** Number of paid queries to make. */
  count: number;
  /** Total spend cap in USDC — the loop stops before exceeding it. */
  limitUsdc: number;
  /** dev = mock header against the DevFacilitator gate; live = real Gateway. */
  mode: "dev" | "live";
  /** Explicit resource paths (ignored when --discover). */
  paths: string[];
  /** Discover resources from /marketplace/catalog instead of --paths. */
  discover: boolean;
  /** Only buy from listings whose provider has on-chain attestations. */
  requireAttested: boolean;
  /** Pause between queries (ms). */
  delayMs: number;
  /** Read /tca/{payer} before buying and let it choose the seller (needs --discover). */
  reroute: boolean;
  /** The saving, in bp on past fills, below which a reroute suggestion is ignored. */
  rerouteMinBp: number;
}

export const DEFAULTS: AgentConfig = {
  api: "http://127.0.0.1:8000",
  count: 20,
  limitUsdc: 0.01,
  mode: "dev",
  paths: ["/prints", "/curve/ACR-INF", "/vol/ACR-INF"],
  discover: false,
  requireAttested: false,
  delayMs: 200,
  reroute: false,
  rerouteMinBp: 25,
};

export function parseArgs(argv: string[]): AgentConfig {
  const cfg: AgentConfig = { ...DEFAULTS, paths: [...DEFAULTS.paths] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--api":
        cfg.api = next().replace(/\/$/, "");
        break;
      case "--count":
        cfg.count = Number(next());
        break;
      case "--limit":
        cfg.limitUsdc = Number(next());
        break;
      case "--dev":
        cfg.mode = "dev";
        break;
      case "--live":
        cfg.mode = "live";
        break;
      case "--paths":
        cfg.paths = next().split(",").map((p) => (p.startsWith("/") ? p : `/${p}`));
        break;
      case "--discover":
        cfg.discover = true;
        break;
      case "--require-attested":
        cfg.requireAttested = true;
        break;
      case "--delay-ms":
        cfg.delayMs = Number(next());
        break;
      case "--reroute":
        cfg.reroute = true;
        break;
      case "--reroute-min-bp":
        cfg.rerouteMinBp = Number(next());
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(cfg.count) || cfg.count < 1) throw new Error("--count must be >= 1");
  if (!Number.isFinite(cfg.limitUsdc) || cfg.limitUsdc <= 0) throw new Error("--limit must be > 0");
  if (!Number.isFinite(cfg.rerouteMinBp) || cfg.rerouteMinBp < 0) throw new Error("--reroute-min-bp must be >= 0");
  // The signal names SELLERS, and only the catalog maps a seller to a resource.
  // With --paths there is no catalog in hand, so there is nothing to reroute between.
  if (cfg.reroute && !cfg.discover) throw new Error("--reroute needs --discover (the catalog is what maps a seller to a listing)");
  return cfg;
}
