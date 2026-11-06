"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, Html, Line, OrbitControls } from "@react-three/drei";
import { useMemo, useRef } from "react";
import type { Group, Mesh } from "three";

import { COLUMN, type Beat } from "@/lib/floatOne";
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
 * Z CARRIES THE ONE THING THAT IS NOT MONEY. The agent sits on its own plane,
 * behind the money, joined to the treasury by a dashed tether and touching
 * nothing. In the flat version it hangs above the rail and a reader has to
 * take the gap on trust; here it is off the plane from every angle the camera
 * can reach, which is the point of letting the camera move at all.
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

/** Custody, left to right. The agent has no column because it holds nothing. */
const X = { treasury: -2.3, sleeve: 0, seller: 2.3, agent: 0 } as const;
/** The agent's plane sits behind the money's. */
const Z = { money: 0, agent: -1.7 } as const;
const FLOOR = 0.3;
const CEIL = 2.3;
const AGENT_Y = 3.3;

/** A beat's point in the scene. `null` when the beat has no log and therefore
 *  no business on an axis of log indices. */
function pointOf(b: Beat): [number, number, number] | null {
  if (b.height === null) return null;
  const col = COLUMN[b.key];
  const x = col === "agent" ? X.agent : col === "treasury" ? X.treasury : col === "sleeve" ? X.sleeve : X.seller;
  return [x, FLOOR + b.height * (CEIL - FLOOR), Z.money];
}

const LABEL: Record<Beat["key"], string> = {
  ask: "agent",
  fair: "benchmark",
  pull: "yield venue",
  pay: "seller",
  receipt: "receipt",
};

const INK = { ether: "#d5e0e7", dim: "#8fa3b8", sand: "#ffcc6f", gold: "#e9a13f", finality: "#4fb3a9", breach: "#ef6a5a" };

function Plate({ x, z, tone }: { x: number; z: number; tone: string }) {
  return (
    <mesh position={[x, 0, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[0.85, 48]} />
      <meshBasicMaterial color={tone} opacity={0.14} transparent />
    </mesh>
  );
}

/** A marker at a beat's own measured height, with its figure beside it. */
function Marker({ beat, tone }: { beat: Beat; tone: string }) {
  const p = pointOf(beat);
  if (!p) return null;
  const bad = beat.state === "bad";
  return (
    <group position={p}>
      <mesh>
        <cylinderGeometry args={[0.3, 0.3, 0.1, 40]} />
        <meshBasicMaterial color={bad ? INK.breach : tone} />
      </mesh>
      <Html center distanceFactor={9} position={[0, 0.42, 0]}>
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
function Puck({ route }: { route: Array<[number, number, number]> }) {
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
      <meshBasicMaterial color={INK.sand} />
    </mesh>
  );
}

/** The agent, behind the money plane, tethered and holding nothing. */
function Agent() {
  const ref = useRef<Group>(null);
  return (
    <group position={[X.agent, AGENT_Y, Z.agent]} ref={ref}>
      <mesh>
        <boxGeometry args={[0.7, 0.26, 0.7]} />
        <meshBasicMaterial color={INK.dim} opacity={0.3} transparent />
      </mesh>
      <Html center distanceFactor={9} position={[0, 0.45, 0]}>
        <div className="scene-tag">
          <span className="scene-tag-name">agent</span>
          <span className="scene-tag-nil">0.00 USDC</span>
          <span className="scene-tag-log">holds nothing</span>
        </div>
      </Html>
    </group>
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
 *  screen stay the gaps in the transaction.
 *
 *  The height fractions are the same numbers the markers use, which is what
 *  keeps the scale and the scene agreeing. */
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

function Scene({ beats, verdict, jit }: { beats: Beat[]; verdict: string; jit: boolean }) {
  const route = useMemo(
    () => beats.map(pointOf).filter((p): p is [number, number, number] => p !== null),
    [beats],
  );
  /* The order is the claim, so its colour follows the chain's verdict rather
     than the designer's optimism. */
  const tone = verdict === "out_of_order" ? INK.breach : verdict === "unproven" ? INK.dim : INK.finality;

  return (
    <>
      <Plate tone={INK.sand} x={X.treasury} z={Z.money} />
      <Plate tone={jit ? INK.gold : INK.dim} x={X.sleeve} z={Z.money} />
      <Plate tone={INK.finality} x={X.seller} z={Z.money} />

      <Agent />

      {/* instruction only, never money: the tether reaches the treasury and
          stops, and it is the one dashed line in the scene. */}
      <Line
        color={INK.dim}
        dashed
        dashScale={4}
        opacity={0.55}
        points={[
          [X.agent, AGENT_Y - 0.2, Z.agent],
          [X.treasury, FLOOR + 0.2, Z.money],
        ]}
        transparent
      />

      {route.length > 1 ? <Line color={tone} linewidth={2} points={route} /> : null}
      {beats.map((b) => (
        <Marker beat={b} key={b.key} tone={tone} />
      ))}
      <Puck route={route} />
    </>
  );
}

export default function OnePaymentScene({
  beats,
  verdict,
  jit,
  label,
}: {
  beats: Beat[];
  verdict: string;
  jit: boolean;
  /** The same sentence the caption carries, for a reader who cannot see it. */
  label: string;
}) {
  const phone = typeof window !== "undefined" && window.innerWidth < 700;
  return (
    <div aria-label={label} className="scene" role="img">
      <AxisOverlay beats={beats} />
      {/* FURTHER BACK ON A PHONE. The marker labels are DOM at a fixed type
          size, so on a 341px canvas the rightmost one reached the frame and was
          clipped by `overflow: hidden`. Standing the camera off brings the
          markers in off the edges instead of shrinking the only text in the
          scene. Read once, which is safe: this component is `ssr: false`, so
          the first render is already in the browser. */}
      <Canvas camera={{ position: phone ? [6.1, 4.4, 8.2] : [4.6, 3.4, 6.2], fov: 42 }} dpr={[1, 2]} frameloop="always">
        <AdaptiveDpr pixelated />
        <OrbitControls
          enablePan={false}
          maxDistance={14}
          maxPolarAngle={Math.PI / 2.05}
          minDistance={4}
          target={[0, 1.3, 0]}
        />
        <Scene beats={beats} jit={jit} verdict={verdict} />
      </Canvas>
    </div>
  );
}
