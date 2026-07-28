/* Tiny linear-scale + path helpers shared by every hand-rolled SVG chart. */

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

export function extent(values: number[], pad = 0): [number, number] {
  if (!values.length) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= Math.abs(lo) * 0.05 || 1;
    hi += Math.abs(hi) * 0.05 || 1;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

export function linePath(xs: number[], ys: number[]): string {
  if (!xs.length) return "";
  let d = `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  for (let i = 1; i < xs.length; i++) d += `L${xs[i].toFixed(2)},${ys[i].toFixed(2)}`;
  return d;
}

/** Closed area between an upper and lower series (the CI ribbon). */
export function bandPath(xs: number[], upper: number[], lower: number[]): string {
  if (!xs.length) return "";
  let d = `M${xs[0].toFixed(2)},${upper[0].toFixed(2)}`;
  for (let i = 1; i < xs.length; i++) d += `L${xs[i].toFixed(2)},${upper[i].toFixed(2)}`;
  for (let i = xs.length - 1; i >= 0; i--) d += `L${xs[i].toFixed(2)},${lower[i].toFixed(2)}`;
  return d + "Z";
}
