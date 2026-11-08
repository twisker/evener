/**
 * Small, dependency-free statistics helpers used by the report (spec §9).
 *
 * Everything here is pure. The Student-t CDF is implemented through the
 * regularised incomplete beta function (Numerical Recipes continued fraction);
 * the inverse CDF uses bisection so it cannot disagree with the forward CDF.
 */

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

/** Arithmetic mean. Empty input returns 0 so report code can call it freely. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample variance (n − 1 denominator). Fewer than two values gives 0. */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let sum = 0;
  for (const x of xs) {
    const d = x - m;
    sum += d * d;
  }
  return sum / (xs.length - 1);
}

/**
 * Linear-interpolated quantile (the usual R type-7 definition). `q` is clamped
 * to [0, 1]; empty input yields `NaN`.
 */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  if (Number.isNaN(q)) return Number.NaN;
  const clamped = Math.min(1, Math.max(0, q));
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? Number.NaN;
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lo = sorted[lower];
  const hi = sorted[upper];
  if (lo === undefined || hi === undefined) return Number.NaN;
  if (lower === upper) return lo;
  return lo + (hi - lo) * (position - lower);
}

// ---------------------------------------------------------------------------
// Gamma / incomplete beta / Student-t
// ---------------------------------------------------------------------------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

/** Lanczos approximation of ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let sum = LANCZOS[0] ?? 0;
  for (let i = 1; i < LANCZOS.length; i += 1) {
    sum += (LANCZOS[i] ?? 0) / (z + i);
  }
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

const BETA_EPS = 3e-14;
const BETA_FPMIN = 1e-300;
const BETA_MAX_ITER = 250;

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETA_FPMIN) d = BETA_FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= BETA_MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETA_FPMIN) d = BETA_FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < BETA_FPMIN) c = BETA_FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETA_FPMIN) d = BETA_FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < BETA_FPMIN) c = BETA_FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < BETA_EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0)) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const logFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(logFront);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student-t CDF P(T <= t) for positive degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) return Number.NaN;
  if (t === 0) return 0.5;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

/** Inverse Student-t CDF by bisection on {@link studentTCdf}. */
export function studentTQuantile(p: number, df: number): number {
  if (!(df > 0)) return Number.NaN;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  if (p === 0.5) return 0;

  let lo = -1;
  let hi = 1;
  while (studentTCdf(lo, df) > p) {
    lo *= 2;
    if (!Number.isFinite(lo)) return Number.NEGATIVE_INFINITY;
  }
  while (studentTCdf(hi, df) < p) {
    hi *= 2;
    if (!Number.isFinite(hi)) return Number.POSITIVE_INFINITY;
  }

  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Welch t-test on two samples
// ---------------------------------------------------------------------------

export interface WelchResult {
  t: number;
  df: number;
  p: number;
}

/**
 * Two-sided Welch t-test. With fewer than two observations in either sample the
 * variance is unknown and the result is a conservative p = 1.
 */
export function welchT(a: readonly number[], b: readonly number[]): WelchResult {
  const nA = a.length;
  const nB = b.length;
  if (nA < 2 || nB < 2) {
    return { t: 0, df: Math.max(nA + nB - 2, 1), p: 1 };
  }

  const meanA = mean(a);
  const meanB = mean(b);
  const varA = variance(a);
  const varB = variance(b);
  const seSquared = varA / nA + varB / nB;

  if (!(seSquared > 0)) {
    if (meanA === meanB) return { t: 0, df: nA + nB - 2, p: 1 };
    return {
      t: meanA > meanB ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      df: nA + nB - 2,
      p: 0,
    };
  }

  const t = (meanA - meanB) / Math.sqrt(seSquared);
  const numerator = seSquared * seSquared;
  const denominator =
    (varA / nA) ** 2 / (nA - 1) + (varB / nB) ** 2 / (nB - 1);
  const df = denominator > 0 ? numerator / denominator : nA + nB - 2;
  const p = Math.min(1, Math.max(0, 2 * (1 - studentTCdf(Math.abs(t), df))));
  return { t, df, p };
}

// ---------------------------------------------------------------------------
// Log-cost confidence interval
// ---------------------------------------------------------------------------

export interface LogCostCI {
  ratio: number;
  lo: number;
  hi: number;
}

function safeLog(x: number): number {
  return Math.log(Math.max(x, 1e-12));
}

/**
 * Ratio of geometric means (a / b) with a two-sided (1 − alpha) confidence
 * interval from the Welch standard error and the Student-t quantile.
 */
export function logCostCI(
  a: readonly number[],
  b: readonly number[],
  alpha: number,
): LogCostCI {
  const logA = a.map(safeLog);
  const logB = b.map(safeLog);
  const diff = mean(logA) - mean(logB);
  const ratio = Math.exp(diff);

  const nA = logA.length;
  const nB = logB.length;
  if (nA < 2 || nB < 2) return { ratio, lo: ratio, hi: ratio };

  const varA = variance(logA);
  const varB = variance(logB);
  const seSquared = varA / nA + varB / nB;
  if (!(seSquared > 0)) return { ratio, lo: ratio, hi: ratio };

  const denominator = (varA / nA) ** 2 / (nA - 1) + (varB / nB) ** 2 / (nB - 1);
  const df = denominator > 0 ? seSquared * seSquared / denominator : nA + nB - 2;
  const tCrit = studentTQuantile(1 - alpha / 2, df);
  const halfWidth = tCrit * Math.sqrt(seSquared);
  return {
    ratio,
    lo: Math.exp(diff - halfWidth),
    hi: Math.exp(diff + halfWidth),
  };
}

// ---------------------------------------------------------------------------
// Normal quantile / MDD
// ---------------------------------------------------------------------------

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
] as const;

/**
 * Standard normal quantile (Acklam's rational approximation, relative error
 * below 1.2e-9). Matches the textbook 1.95996 at p = 0.975.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((ACKLAM_C[0] ?? 0) * q + (ACKLAM_C[1] ?? 0)) * q + (ACKLAM_C[2] ?? 0)) * q +
        (ACKLAM_C[3] ?? 0)) * q + (ACKLAM_C[4] ?? 0)) * q + (ACKLAM_C[5] ?? 0);
    const denominator =
      ((((ACKLAM_D[0] ?? 0) * q + (ACKLAM_D[1] ?? 0)) * q + (ACKLAM_D[2] ?? 0)) * q +
        (ACKLAM_D[3] ?? 0)) * q + 1;
    x /= denominator;
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((ACKLAM_A[0] ?? 0) * r + (ACKLAM_A[1] ?? 0)) * r + (ACKLAM_A[2] ?? 0)) * r +
        (ACKLAM_A[3] ?? 0)) * r + (ACKLAM_A[4] ?? 0)) * r + (ACKLAM_A[5] ?? 0)) * q;
    const denominator =
      (((((ACKLAM_B[0] ?? 0) * r + (ACKLAM_B[1] ?? 0)) * r + (ACKLAM_B[2] ?? 0)) * r +
        (ACKLAM_B[3] ?? 0)) * r + (ACKLAM_B[4] ?? 0)) * r + 1;
    x /= denominator;
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((ACKLAM_C[0] ?? 0) * q + (ACKLAM_C[1] ?? 0)) * q + (ACKLAM_C[2] ?? 0)) * q +
        (ACKLAM_C[3] ?? 0)) * q + (ACKLAM_C[4] ?? 0)) * q + (ACKLAM_C[5] ?? 0);
    const denominator =
      ((((ACKLAM_D[0] ?? 0) * q + (ACKLAM_D[1] ?? 0)) * q + (ACKLAM_D[2] ?? 0)) * q +
        (ACKLAM_D[3] ?? 0)) * q + 1;
    x /= denominator;
  }

  return x;
}

/**
 * Minimum relative difference detectable with a two-sided test at `alpha` and
 * the given `power`, using the normal approximation:
 *
 *   exp((z_{1−α/2} + z_power) · sd · sqrt(1/nA + 1/nB)) − 1
 */
export function mdd(
  nA: number,
  nB: number,
  pooledSdLog: number,
  alpha: number,
  power: number,
): number {
  if (!(nA > 0) || !(nB > 0)) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(pooledSdLog) || pooledSdLog < 0) return Number.NaN;
  if (pooledSdLog === 0) return 0;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.exp(z * pooledSdLog * Math.sqrt(1 / nA + 1 / nB)) - 1;
}

/** Pooled sample standard deviation of two samples (for MDD). */
export function pooledSd(a: readonly number[], b: readonly number[]): number {
  const nA = a.length;
  const nB = b.length;
  const denominator = nA + nB - 2;
  if (nA < 2 || nB < 2 || denominator <= 0) return 0;
  const numerator = (nA - 1) * variance(a) + (nB - 1) * variance(b);
  return Math.sqrt(numerator / denominator);
}
