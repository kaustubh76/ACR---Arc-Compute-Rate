"use client";

import { Canvas, invalidate, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, Html, Line, OrbitControls } from "@react-three/drei";
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Mesh } from "three";

import { agentPoint, benchmarkPoint, pointOf, SCENE, type Beat, type BeatKey } from "@/lib/floatOne";
import { fmtInt, fmtPrice, shortAddr } from "@/lib/format";

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

const LABEL: Record<BeatKey, string> = {
  ask: "agent",
  fair: "benchmark",
  /* NAMED FOR WHAT IT IS, and not "the yield venue" any more. Our own sleeve
     used to carry that label while the thing actually holding the money had no
     station at all; separating them is the point of this plane. */
  venue: "morpho vault v2",
  pull: "our sleeve",
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
function Marker({
  beat,
  tone,
  portal,
  on,
}: {
  beat: Beat;
  tone: string;
  portal: Portal;
  /** Lit by the run. A station that has not been reached is drawn but dim, so a
   *  reader can see where the payment is going without being told it got there. */
  on: boolean;
}) {
  const p = pointOf(beat);
  if (!p) return null;
  return (
    <group position={p}>
      <mesh>
        <cylinderGeometry args={[0.3, 0.3, 0.1, 40]} />
        <meshBasicMaterial color={tone} opacity={on ? 1 : 0.22} transparent />
      </mesh>
      <Html center distanceFactor={9} portal={portal} position={[0, 0.42, 0]}>
        <div className={on ? "scene-tag" : "scene-tag scene-tag-off"}>
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

/** The venue, on the plane that is not ours, with what it actually did.
 *
 *  THE COUNTERPARTY GETS THE MOST DETAIL ON THE PAGE, because it is the one
 *  party here nobody at ACR controls. `WhoTouches` says it could close our
 *  exit; this says what it did when it did not. The receiver is the headline:
 *  the venue paid the TREASURY, not our sleeve, so the money never rested in
 *  the wrapper that asked for it.
 *
 *  TWO OF ITS FOUR LOGS ARE COUNTED AND NOT CAPTIONED. They are Morpho's own
 *  bookkeeping and this surface has no business asserting what they are. */
function VenueMarker({
  beat,
  tone,
  portal,
  on,
  usdc,
  receiver,
  shares,
  logs,
  treasury,
}: {
  beat: Beat;
  tone: string;
  portal: Portal;
  on: boolean;
  usdc: number | null;
  receiver: string | null;
  shares: string | null;
  logs: number | null;
  treasury: string | null;
}) {
  const p = pointOf(beat);
  if (!p) return null;
  const toTreasury = Boolean(receiver && treasury && receiver.toLowerCase() === treasury.toLowerCase());
  return (
    <group position={p}>
      <mesh>
        <boxGeometry args={[0.62, 0.3, 0.62]} />
        <meshBasicMaterial color={tone} opacity={on ? 0.9 : 0.2} transparent />
      </mesh>
      <Html center distanceFactor={9} portal={portal} position={[0, 0.46, 0]}>
        <div className={on ? "scene-tag scene-tag-outside" : "scene-tag scene-tag-outside scene-tag-off"}>
          <span className="scene-tag-name">{LABEL.venue}</span>
          <span className="scene-tag-not-ours">not ours</span>
          <span className="scene-tag-fig">{usdc === null ? "…" : `${fmtPrice(usdc)} USDC out`}</span>
          <span className="scene-tag-log">
            {receiver === null ? "…" : toTreasury ? "straight to the treasury" : `to ${shortAddr(receiver)}`}
          </span>
          <span className="scene-tag-log">
            {shares === null ? "…" : `burns ${fmtPrice(Number(shares) / 1e18)} shares`}
          </span>
          <span className="scene-tag-log">
            {beat.logIndex === null ? "no log" : `log ${beat.logIndex}`}
            {logs === null || logs <= 2 ? "" : ` · +${fmtInt(logs - 2)} internal`}
          </span>
        </div>
      </Html>
    </group>
  );
}

/** The USDC travelling, along the beats the chain actually logged.
 *
 *  It walks the proven polyline and nothing else: a beat with no log is not on
 *  the route, so the puck cannot imply a hop nobody measured. */
function Puck({
  route,
  tone,
  running,
}: {
  route: Array<[number, number, number]>;
  tone: string;
  /** Only moves during a run. Idle, the scene is a still picture and the loop
   *  is parked on "demand", which is why there is nothing to pause. */
  running: boolean;
}) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m || !running || route.length < 2) return;
    const legs = route.length - 1;
    const t = (clock.getElapsedTime() % (legs * 1.5)) / 1.5;
    const i = Math.min(Math.floor(t), legs - 1);
    const f = t - i;
    const [ax, ay, az] = route[i];
    const [bx, by, bz] = route[i + 1];
    m.position.set(ax + (bx - ax) * f, ay + (by - ay) * f + Math.sin(f * Math.PI) * 0.18, az + (bz - az) * f);
  });
  if (!running || route.length < 2) return null;
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
  lit,
  running,
  venueUsdc,
  venueReceiver,
  venueShares,
  venueLogs,
  treasury,
}: {
  beats: Beat[];
  verdict: string;
  jit: boolean;
  quoteUsdc: number | null;
  fairUsdc: number | null;
  fairMatches: boolean | null;
  portal: Portal;
  /** Which stations the run has reached. Empty before anyone presses anything. */
  lit: ReadonlySet<BeatKey>;
  running: boolean;
  venueUsdc: number | null;
  venueReceiver: string | null;
  venueShares: string | null;
  venueLogs: number | null;
  /** To tell "the venue paid the treasury" from "the venue paid someone else",
   *  which is the whole of the one-hop claim. */
  treasury: string | null;
}) {
  const ink = useInk();
  /* THE PUCK WALKS ONLY WHAT THE RUN HAS REACHED. Its route is the lit beats in
     order, so it cannot arrive somewhere the chain has not been shown to have
     taken the money. A refusal leaves it with nowhere to go. */
  const route = useMemo(
    () =>
      beats
        .filter((b) => lit.has(b.key))
        .map(pointOf)
        .filter((p): p is [number, number, number] => p !== null),
    [beats, lit],
  );
  /* The whole proven path, drawn faintly whether or not the run has got there,
     so a reader can see where it is going. */
  const full = useMemo(
    () => beats.map(pointOf).filter((p): p is [number, number, number] => p !== null),
    [beats],
  );
  /* The order is the claim, so its colour follows the chain's verdict rather
     than the designer's optimism. */
  const tone = verdict === "out_of_order" ? ink.breach : verdict === "unproven" ? ink.dim : ink.finality;
  const agentAt = agentPoint();
  const benchAt = benchmarkPoint();
  const venueBeat = beats.find((b) => b.key === "venue");

  return (
    <>
      <Plate tone={ink.sand} x={SCENE.x.treasury} z={SCENE.z.money} />
      <Plate tone={jit ? ink.gold : ink.dim} x={SCENE.x.sleeve} z={SCENE.z.money} />
      <Plate tone={ink.finality} x={SCENE.x.seller} z={SCENE.z.money} />
      {/* The plane that is not ours gets a plate of its own, in front. */}
      {venueBeat?.height === null ? null : <Plate tone={ink.dim} x={SCENE.x.venue} z={SCENE.z.outside} />}

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

      {full.length > 1 ? <Line color={ink.dim} linewidth={1} opacity={0.3} points={full} transparent /> : null}
      {route.length > 1 ? <Line color={tone} linewidth={2} points={route} /> : null}
      {beats.map((b) =>
        b.key === "venue" ? (
          <VenueMarker
            beat={b}
            key={b.key}
            logs={venueLogs}
            on={lit.has(b.key)}
            portal={portal}
            receiver={venueReceiver}
            shares={venueShares}
            tone={ink.gold}
            treasury={treasury}
            usdc={venueUsdc}
          />
        ) : (
          <Marker beat={b} key={b.key} on={lit.has(b.key)} portal={portal} tone={tone} />
        ),
      )}
      <Puck route={route} running={running} tone={ink.sand} />
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
  lit,
  running,
  venueUsdc,
  venueReceiver,
  venueShares,
  venueLogs,
  treasury,
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
  /** Which stations the run has reached, and whether one is under way. The run
   *  itself is driven in `OnePayment3D`, because what starts it is a chain read
   *  and a chain read does not belong inside a render loop. */
  lit: ReadonlySet<BeatKey>;
  running: boolean;
  venueUsdc: number | null;
  venueReceiver: string | null;
  venueShares: string | null;
  venueLogs: number | null;
  treasury: string | null;
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

     CHANGING THE PROP BACK IS NOT ENOUGH, which took reading R3F's loop to
     learn rather than guessing at it. `loop()` cancels itself the moment a
     frame is not needed (`if (repeat === 0) { running = false; return
     cancelAnimationFrame(frame) }`), and the ONLY thing that starts it again is
     `invalidate()`. `setFrameloop` just sets the clock and the store, so a
     stopped loop stays stopped however the prop changes. Measured first with
     "never": 120 `requestAnimationFrame` callbacks over two seconds on screen,
     0 off it, and 0 again after scrolling BACK. The scene froze for good the
     first time it left the viewport.

     So two halves, and both are needed. "demand" rather than "never", because
     `invalidate()` returns early on "never" and could never restart anything,
     which also kills the frame OrbitControls asks for on a drag. And an
     explicit `invalidate()` when the section comes back, to start the loop that
     stopped itself. */
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((rows) => setSeen(rows.some((r) => r.isIntersecting)), {
      rootMargin: "120px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* START THE LOOP THAT STOPPED ITSELF. R3F's `loop()` cancels on the first
     frame nothing needs, and only `invalidate()` restarts it, so both becoming
     visible and starting a run have to say so explicitly. `lit` is in here too
     because a refusal changes what is drawn without any frame being requested:
     the stations have to repaint once even though nothing is moving. */
  useEffect(() => {
    if (seen) invalidate();
  }, [seen, running, lit]);

  return (
    <div aria-label={label} className="scene" ref={box} role="img">
      <AxisOverlay beats={beats} />
      {/* The portal root, before the Canvas so it exists first. */}
      <div className="scene-labels" ref={labels} />
      <Canvas
        camera={{ position: phone ? [6.1, 4.4, 8.2] : [4.6, 3.4, 6.2], fov: 42 }}
        dpr={[1, 2]}
        frameloop={running && seen ? "always" : "demand"}
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
          lit={lit}
          portal={portal}
          quoteUsdc={quoteUsdc}
          running={running}
          treasury={treasury}
          venueLogs={venueLogs}
          venueReceiver={venueReceiver}
          venueShares={venueShares}
          venueUsdc={venueUsdc}
          verdict={verdict}
        />
      </Canvas>
    </div>
  );
}
