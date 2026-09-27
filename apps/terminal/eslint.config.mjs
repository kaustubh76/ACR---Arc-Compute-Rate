/* Flat ESLint config. Next 16 removed `next lint`, and the script it replaced had
   never actually linted this project: with no config present, `next lint` only
   printed its interactive setup prompt. So this is the first configuration that
   runs here, and it is deliberately Next's own recommended set rather than a
   house style — the value is catching real React and Next mistakes (bad hook
   calls, <img> over next/image, missing keys), not relitigating formatting that
   nothing else in this repo enforces either.

   eslint-config-next 16 ships native flat configs, so it is spread directly;
   wrapping it in FlatCompat throws "Converting circular structure to JSON". */
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "scripts/**"] },
  ...(Array.isArray(coreWebVitals) ? coreWebVitals : [coreWebVitals]),
  ...(Array.isArray(typescript) ? typescript : [typescript]),
  {
    rules: {
      /* A warning, not an error, and on purpose. The rule is right in general —
         setState in an effect body cascades renders — but all fourteen sites it
         flags here are the legitimate half of its own guidance: subscribing to an
         external system (a chain read, a Gateway balance, an SWR refresh) and
         writing the result into state. Rewriting fourteen data syncs across eight
         files on the eve of a public launch would risk the UI to satisfy a
         performance advisory, so they are recorded and left. An ERROR from this
         rule on a NEW site still deserves the rewrite.
         Tracked with audit L2 in docs/SECURITY-AUDIT.md. */
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
