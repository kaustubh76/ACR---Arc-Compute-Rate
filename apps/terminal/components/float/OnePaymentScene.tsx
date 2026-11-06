"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, Html, Line, OrbitControls } from "@react-three/drei";
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Mesh } from "three";

import { agentPoint, benchmarkPoint, pointOf, SCENE, type Beat } from "@/lib/floatOne";
import { fmtPrice } from "@/lib/format";

/* One payment, plotted. The WebGL half; the words live in OnePayment3D.tsx.
 *
 * THE TWO AXES BOTH MEAN SOMETHING, which is the only reason this is in three
 * dimensions rather than drawn. X is custody: treasury, the yield venue, the
 * seller. Y is the payment's own LOG INDEX inside its one transaction, taken
 * off `/api/float/walk` and normalised in `lib/floatOne.ts` with the real gaps
 * kept. So "the shortfall left the venue before the seller was paid" is not a
 * drawing decision here: the pull marker is lower than the pay marker because
 * the chain reported it lower, and when the chain says otherwise the picture
 * comes out wrong. A diagram that cannot be wrong is not evidence.
 *
 * THE GEOMETRY LIVES IN `lib/floatOne.ts`, under test. "The agent is never on
 * the money plane" is a claim, and a claim belongs somewhere a suite can fail
 * it rather than somewhere a reviewer can nod at it.
 *
 * TWO PLANES. `z.money` holds everything that moves USDC. `z.offPlane` holds
 * the two things that do not: the agent, which sends an instruction and holds
 * nothing, and the benchmark, which checks a price and never touches a
 * balance. Both are above the axis rather than on it, because neither emits a
 * log and a position on an axis of log indices would be a number nobody
 * measured.
 *
 * EVERY FIGURE IS DOM, NOT GEOMETRY. The labels are drei `<Html>`, so each
 * number is real text: in the accessibility tree, selectable, and wearing the
 * stylesheet's own tokens. Text rasterised into the canvas would be invisible
 * to a screen reader and to `scripts/measure-ui.mjs`, and this surface is a
 * claim about money.
 *
 * THE LABELS ARE REGISTER-NEUTRAL, for the reason MoneyPath.tsx:31-34 gives:
 * `useEdition()` resolves to expert on the server, so a dual register inside
 * the scene would flash on hydration. Plain nouns here, and the sentence that
 * explains them dual-renders in the caption underneath. */

const LABEL: Record<Beat["key"], string> = {
  ask: "agent",
  fair: "benchmark",
  pull: "yield venue",
  pay: "seller",
  receipt: "receipt",
};

/** The Arc Dawn tokens this scene needs, READ OFF THE STYLESHEET.
 *
 *  WEBGL COLOUR IS THE ONE SURFACE NO CSS GATE CAN SEE. `lib/coverage.test.ts`
 *  checks that every class exists and that no inline style carries an off-scale
 *  number, and neither can look inside a `MeshBasicMaterial`. So the first
 *  version of this file hardcoded six hexes, five of which matched `:root` and
 *  one of which (`#8fa3b8`) was in no stylesheet at all: a colour the design
 *  system had never heard of, invisible to every check in the repo.
 *
 *  Reading the computed values also makes the scene contextual the way the rest
 *  of the terminal is: `--sky` is redefined under `[data-room="adversary"]`, so
 *  a literal is wrong in principle and not just wrong here. Safe to read at
 *  mount because this component is `ssr: false` and its first render is already
 *  in the browser; the literals stay only as a fallback for a computed value
 *  that comes back empty. */
const INK_FALLBACK = {
  ether: "#d5e0e7",
  dim: "#acc6e9",
  sand: "#ffcc6f",
  gold: "#e9a13f",
  finality: "#4fb3a9",
  breach: "#ef6a5a",
} as const;

type Ink = Record<keyof typeof INK_FALLBACK, string>;

/* EVERY LABEL PORTALS INTO A CONTAINER THIS COMPONENT OWNS.
 *
 * MEASURED, TWICE. Left to its own devices, drei mounts the FIRST `<Html>` in
 * the tree with an empty wrapper: a div at the right screen position carrying
 * no children, and no error. The axis lost its lowest tick to this (three
 * wrappers, two numbers) and when the benchmark node arrived it took the
 * AGENT'S label instead, which is the one label this whole product is about:
 * "0.00 USDC, holds nothing". Each time the symptom moved to whichever `<Html>`
 * rendered first, which is the tell: the portal root does not exist yet when
 * the first one commits.
 *
 * `portal` is drei's own answer. A container that exists from the first render,
 * before any `<Html>` mounts, so none of them has to create it. It also makes
 * the stacking and the pointer behaviour ours to set rather than inherited. */
type Portal = React.RefObject<HTMLElement>;

function readInk(): Ink {
  if (typeof document === "undefined") return INK_FALLBACK;
  const s = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    ether: read("--ether", INK_FALLBACK.ether),
    dim: read("--sky", INK_FALLBACK.dim),
    sand: read("--sand", INK_FALLBACK.sand),
    gold: read("--gold", INK_FALLBACK.gold),
    finality: read("--finality", INK_FALLBACK.finality),
    breach: read("--breach", INK_FALLBACK.breach),
  };
}

/** A LAZY INITIALIZER, NOT AN EFFECT. Reading these in an effect meant a
 *  render with the fallback literals and then a second render with the real
 *  tokens, which `react-hooks/set-state-in-effect` is right to flag as a
 *  cascading render. There is no need for the effect at all: this component is
 *  `ssr: false`, so its FIRST render is already in the browser and
 *  `getComputedStyle` is available there. One render, right colours. */
function useInk(): Ink {
  const [ink] = useState(readInk);
  return ink;
}

function Plate({ x, z, tone }: { x: number; z: number; tone: string }) {
  return (
    <mesh position={[x, 0, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[0.85, 48]} />
      <meshBasicMaterial color={tone} opacity={0.14} transparent />
    </mesh>
  );
}

/** A marker at a beat's own measured height, with its figure beside it. */
function Marker({ beat, tone, portal }: { beat: Beat; tone: string; portal: Portal }) {
  const p = pointOf(beat);
  if (!p) return null;
  return (
    <group position={p}>
      <mesh>
        <cylinderGeometry args={[0.3, 0.3, 0.1, 40]} />
        <meshBasicMaterial color={tone} />
      </mesh>
      <Html center distanceFactor={9} portal={portal} position={[0, 0.42, 0]}>
        <div className="scene-tag">
          <span className="scene-tag-name">{LABEL[beat.key]}</span>
          <span className="scene-tag-fig">
            {beat.valueUsdc === null ? "…" : `${fmtPrice(beat.valueUsdc)} USDC`}
          </span>
          <span className="scene-tag-log">{beat.logIndex === null ? "no log" : `log ${beat.logIndex}`}</span>
        </div>
      </Html>
    </group>
  );
}

/** The USDC travelling, along the beats the chain actually logged.
 *
 *  It walks the proven polyline and nothing else: a beat with no log is not on
 *  the route, so the puck cannot imply a hop nobody measured. */
function Puck({ route, tone }: { route: Array<[number, number, number]>; tone: string }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m || route.length < 2) return;
    const legs = route.length - 1;
    const t = (clock.getElapsedTime() % (legs * 1.5)) / 1.5;
    const i = Math.min(Math.floor(t), legs - 1);
    const f = t - i;
    const [ax, ay, az] = route[i];
    const [bx, by, bz] = route[i + 1];
    m.position.set(ax + (bx - ax) * f, ay + (by - ay) * f + Math.sin(f * Math.PI) * 0.18, az + (bz - az) * f);
  });
  if (route.length < 2) return null;
  return (
    <mesh ref={ref} position={route[0]}>
      <sphereGeometry args={[0.13, 20, 20]} />
      <meshBasicMaterial color={tone} />
    </mesh>
  );
}

/** The agent, off the money plane, tethered and holding nothing. */
function Agent({ ink, portal }: { ink: Ink; portal: Portal }) {
  return (
    <group position={agentPoint()}>
      <mesh>
        <boxGeometry args={[0.7, 0.26, 0.7]} />
        <meshBasicMaterial color={ink.dim} opacity={0.3} transparent />
      </mesh>
      <Html center distanceFactor={9} portal={portal} position={[0, 0.45, 0]}>
        <div className="scene-tag">
          <span className="scene-tag-name">agent</span>
          <span className="scene-tag-nil">0.00 USDC</span>
          <span className="scene-tag-log">holds nothing</span>
        </div>
      </Html>
    </group>
  );
}

/** The benchmark, over the treasury, off the money plane.
 *
 *  THE BENCHMARK IS THE PRODUCT, and the first version of this scene left it
 *  out: it had a label for it and drew nothing, because the fair check emits no
 *  log and so has no place on the axis. `MoneyPath.tsx:36-42` already says why
 *  that is the one thing not to drop — it is the check that makes this treasury
 *  different from a wallet with a limit, and leaving it out made the WebGL
 *  version LESS informative than the flat SVG it replaces.
 *
 *  THREE STATES, AND THE MIDDLE ONE IS NOT A PASS. `fairMatches` is `null`
 *  when the print the receipt named could not be found afterwards, which is an
 *  absence, not agreement. It renders dim and says so. */
function Benchmark({
  ink,
  portal,
  quoteUsdc,
  fairUsdc,
  fairMatches,
}: {
  ink: Ink;
  portal: Portal;
  quoteUsdc: number | null;
  fairUsdc: number | null;
  fairMatches: boolean | null;
}) {
  const tone = fairMatches === false ? ink.breach : fairMatches === null ? ink.dim : ink.finality;
  return (
    <group position={benchmarkPoint()}>
      <mesh>
        <boxGeometry args={[0.8, 0.24, 0.8]} />
        <meshBasicMaterial color={tone} opacity={0.3} transparent />
      </mesh>
      <Html center distanceFactor={9} portal={portal} position={[0, 0.44, 0]}>
        <div className="scene-tag">
          <span className="scene-tag-name">benchmark</span>
          <span className="scene-tag-fig">{fairUsdc === null ? "…" : `${fmtPrice(fairUsdc)} fair`}</span>
          <span className="scene-tag-fig">{quoteUsdc === null ? "…" : `${fmtPrice(quoteUsdc)} asked`}</span>
          <span className={fairMatches === false ? "scene-tag-bad" : "scene-tag-log"}>
            {fairMatches === false ? "does not match" : fairMatches === null ? "unchecked" : "recomputed, matches"}
          </span>
        </div>
      </Html>
    </group>
  );
}

function Scene({
  beats,
  verdict,
  jit,
  quoteUsdc,
  fairUsdc,
  fairMatches,
  portal,
}: {
  beats: Beat[];
  verdict: string;
  jit: boolean;
  quoteUsdc: number | null;
  fairUsdc: number | null;
  fairMatches: boolean | null;
  portal: Portal;
}) {
  const ink = useInk();
  const route = useMemo(
    () => beats.map(pointOf).filter((p): p is [number, number, number] => p !== null),
    [beats],
  );
  /* The order is the claim, so its colour follows the chain's verdict rather
     than the designer's optimism. */
  const tone = verdict === "out_of_order" ? ink.breach : verdict === "unproven" ? ink.dim : ink.finality;
  const agentAt = agentPoint();
  const benchAt = benchmarkPoint();

  return (
    <>
      <Plate tone={ink.sand} x={SCENE.x.treasury} z={SCENE.z.money} />
      <Plate tone={jit ? ink.gold : ink.dim} x={SCENE.x.sleeve} z={SCENE.z.money} />
      <Plate tone={ink.finality} x={SCENE.x.seller} z={SCENE.z.money} />

      <Agent ink={ink} portal={portal} />
      <Benchmark fairMatches={fairMatches} fairUsdc={fairUsdc} ink={ink} portal={portal} quoteUsdc={quoteUsdc} />

      {/* instruction only, never money: the tether reaches the treasury and
          stops, and it is one of the two dashed lines in the scene. */}
      <Line
        color={ink.dim}
        dashed
        dashScale={4}
        opacity={0.55}
        points={[agentAt, [SCENE.x.treasury, SCENE.floor + 0.2, SCENE.z.money]]}
        transparent
      />
      {/* the benchmark hangs over the treasury because the treasury is what
          does the checking, and it reads a price rather than moving money. */}
      <Line
        color={tone === ink.breach ? ink.breach : ink.dim}
        dashed
        dashScale={4}
        opacity={0.55}
        points={[benchAt, [SCENE.x.treasury, SCENE.floor + 0.2, SCENE.z.money]]}
        transparent
      />

      {route.length > 1 ? <Line color={tone} linewidth={2} points={route} /> : null}
      {beats.map((b) => (
        <Marker beat={b} key={b.key} portal={portal} tone={tone} />
      ))}
      <Puck route={route} tone={ink.sand} />
    </>
  );
}

/** The log-index axis, pinned to the frame rather than placed in the scene.
 *
 *  TWO REASONS IT IS DOM AND NOT GEOMETRY, and the first is the honest one: an
 *  axis that rotates with the camera stops being an axis. The reader is invited
 *  to drag the scene, and a scale that swings away from the frame and reads
 *  upside down at some angles is worse than no scale.
 *
 *  The second is measured. Each tick was a drei `<Html>` inside the rotating
 *  group, and a headless census found three wrappers carrying only two labels:
 *  one portal mounted with no text in it, so an axis whose whole job is to
 *  print three log indices printed two. Pinned DOM has one node per tick, no
 *  portal, and `bottom` set straight from the normalised height, so the gaps on
 *  screen stay the gaps in the transaction. */
function AxisOverlay({ beats }: { beats: Beat[] }) {
  const ticks = beats.filter(
    (b): b is Beat & { height: number; logIndex: number } => b.height !== null && typeof b.logIndex === "number",
  );
  if (ticks.length === 0) return null;
  return (
    <div aria-hidden className="scene-axis">
      {ticks.map((b) => (
        <span className="scene-axis-tick" key={b.key} style={{ bottom: `${b.height * 100}%` }}>
          {b.logIndex}
        </span>
      ))}
    </div>
  );
}

export default function OnePaymentScene({
  beats,
  verdict,
  jit,
  label,
  quoteUsdc,
  fairUsdc,
  fairMatches,
  onContextLost,
}: {
  beats: Beat[];
  verdict: string;
  jit: boolean;
  /** The same sentence the caption carries, for a reader who cannot see it. */
  label: string;
  quoteUsdc: number | null;
  fairUsdc: number | null;
  fairMatches: boolean | null;
  /** A lost GPU context hands the section back to the flat SVG. */
  onContextLost: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  /* ONE CAST, AT THE SOURCE. drei types `portal` as a non-nullable
     `RefObject<HTMLElement>` while React 19's `useRef(null)` is nullable, and
     drei reads `.current` lazily at paint, so the stricter type describes its
     behaviour less accurately than this does. Cast once here rather than at
     each of the three labels; the div keeps its own correct ref type. */
  const portal = labels as unknown as Portal;
  const [seen, setSeen] = useState(true);
  /* FURTHER BACK ON A PHONE. The marker labels are DOM at a fixed type size, so
     on a 341px canvas the rightmost one reached the frame and was clipped by
     `overflow: hidden`. Standing the camera off brings the markers in off the
     edges instead of shrinking the only text in the scene. Read once, which is
     safe: this component is `ssr: false`, so the first render is in the
     browser. */
  const phone = typeof window !== "undefined" && window.innerWidth < 700;

  /* THE RENDER LOOP IDLES WHEN NOBODY IS LOOKING. `frameloop="always"` keeps a
     GPU busy drawing a payment that is scrolled off the screen, which on a
     laptop is measurable battery for nothing. `/float` is a long page and this
     section is near the top, so it is off-screen most of the time a reader
     spends here.

     "DEMAND" AND NOT "NEVER", WHICH IS A MEASURED DISTINCTION. Both stop the
     loop: counting `requestAnimationFrame` over two seconds gave 120 on screen
     and 0 off it either way. But "never" tears the loop down and scrolling BACK
     gave 0 as well, so the scene froze for good the first time it left the
     viewport. "demand" renders only when something asks, which idles at zero
     just the same and resumes when it becomes visible again. */
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((rows) => setSeen(rows.some((r) => r.isIntersecting)), {
      rootMargin: "120px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div aria-label={label} className="scene" ref={box} role="img">
      <AxisOverlay beats={beats} />
      {/* The portal root, before the Canvas so it exists first. */}
      <div className="scene-labels" ref={labels} />
      <Canvas
        camera={{ position: phone ? [6.1, 4.4, 8.2] : [4.6, 3.4, 6.2], fov: 42 }}
        dpr={[1, 2]}
        frameloop={seen ? "always" : "demand"}
        /* Not a tab stop: OrbitControls is pointer-only, and every figure in
           here is already DOM text in the tags and in the table below, so a
           keyboard reader loses nothing by skipping it and gains not landing
           on a control that does nothing. */
        onCreated={({ gl }) => {
          gl.domElement.tabIndex = -1;
          gl.domElement.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            onContextLost();
          });
        }}
      >
        {/* No `pixelated`: it disables smoothing on downscale, which is wrong
            for a surface whose job is reading small figures. */}
        <AdaptiveDpr />
        <OrbitControls
          enablePan={false}
          maxDistance={14}
          maxPolarAngle={Math.PI / 2.05}
          minDistance={4}
          target={[0, 1.3, 0]}
        />
        <Scene
          beats={beats}
          fairMatches={fairMatches}
          fairUsdc={fairUsdc}
          jit={jit}
          portal={portal}
          quoteUsdc={quoteUsdc}
          verdict={verdict}
        />
      </Canvas>
    </div>
  );
}
