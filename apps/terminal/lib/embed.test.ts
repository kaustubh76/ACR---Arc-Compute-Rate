import { test } from "node:test";
import assert from "node:assert/strict";
import { embedSnippets, previewUrl, badgeUrl, cardUrl } from "./embed";

const ORIGIN = "https://terminal.example/";
const SELLER = "https://press.example";

test("the badge snippet is a Markdown image that links to the index page", () => {
  const s = embedSnippets(ORIGIN, "ACR-INF", SELLER);
  assert.equal(
    s.badge,
    "[![ACR-INF, the Arc Compute Rate for inference](https://terminal.example/api/badge/ACR-INF.svg)](https://terminal.example/index/ACR-INF)",
  );
});

test("the card snippet is an HTML image with alt text, sized to the SVG", () => {
  const s = embedSnippets(ORIGIN, "ACR-GPU", SELLER);
  assert.match(s.card, /^<a href="https:\/\/terminal\.example\/index\/ACR-GPU">/);
  assert.match(s.card, /src="https:\/\/terminal\.example\/api\/card\/ACR-GPU\.svg"/);
  assert.match(s.card, /width="320" height="160"/);
  assert.match(s.card, /alt="ACR-GPU, the Arc Compute Rate for gpu compute"/);
});

test("the curl reads the on-chain print from the press, not from the terminal", () => {
  const s = embedSnippets(ORIGIN, "ACR-DATA", `${SELLER}/`);
  assert.equal(s.curl, "curl -s https://press.example/onchain/ACR-DATA");
});

test("a trailing slash on the origin never doubles up", () => {
  assert.equal(badgeUrl("https://a.test///", "ACR-INF"), "https://a.test/api/badge/ACR-INF.svg");
  assert.equal(cardUrl("https://a.test", "ACR-INF"), "https://a.test/api/card/ACR-INF.svg");
});

test("only the image snippets have a preview", () => {
  assert.equal(previewUrl(ORIGIN, "ACR-INF", "badge"), "https://terminal.example/api/badge/ACR-INF.svg");
  assert.equal(previewUrl(ORIGIN, "ACR-INF", "card"), "https://terminal.example/api/card/ACR-INF.svg");
  assert.equal(previewUrl(ORIGIN, "ACR-INF", "curl"), null);
});
