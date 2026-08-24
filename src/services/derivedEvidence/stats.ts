/** Local-only statistics. Never imported by packet projection. */

export const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const stdev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};

export const coefficientOfVariation = (values: number[]): number => {
  const m = mean(values);
  const spread = stdev(values);
  if (m === 0) return spread === 0 ? 0 : Number.POSITIVE_INFINITY;
  return spread / Math.abs(m);
};

export const olsSlope = (values: number[]): number => {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
};

export const relativeChange = (values: number[]): number => {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return last === 0 ? 0 : Math.sign(last);
  return (last - first) / Math.abs(first);
};

export const herfindahlHirschman = (weights: number[]): number => {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  return weights.reduce((sum, value) => sum + (value / total) ** 2, 0);
};

export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

export const medianGap = (sorted: number[]): number | null => {
  if (sorted.length < 2) return null;
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index]);
  return median(gaps);
};

export const pearson = (xs: number[], ys: number[]): number | null => {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
};


