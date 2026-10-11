import { readFile } from "node:fs/promises";
import { join } from "node:path";

/* The face the preview images are set in.
 *
 * IBM Plex Mono is the terminal's data face, and `next/og` cannot reach a
 * `next/font/google` import: those are CSS, resolved for the browser. The two
 * weights are vendored under assets/fonts (OFL 1.1, licence alongside) and
 * read from disk once, at first use, so the build fetches nothing and a
 * request fetches nothing. `next.config.mjs` pins the folder into the server
 * trace for the two routes that read it; a font that failed to ship would
 * 500 every unfurl, silently, which is why it is pinned rather than trusted
 * to the tracer. */

const DIR = join(process.cwd(), "assets", "fonts");

export type OgFont = { name: string; data: Buffer; weight: 400 | 500; style: "normal" };

let fonts: Promise<OgFont[]> | null = null;

export function plexFonts(): Promise<OgFont[]> {
  fonts ??= Promise.all([
    readFile(join(DIR, "IBMPlexMono-Regular.ttf")),
    readFile(join(DIR, "IBMPlexMono-Medium.ttf")),
  ]).then(([regular, medium]) => [
    { name: "Plex", data: regular, weight: 400, style: "normal" },
    { name: "Plex", data: medium, weight: 500, style: "normal" },
  ]);
  return fonts;
}
