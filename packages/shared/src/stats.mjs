// Sample statistics. Follows the discipline of octane's benchmarks/lib/stats:
// median headline, t-distribution CI for small n, raw samples retained.

const T_CRITICAL_95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
};
const tCritical = (df) => (df <= 30 ? T_CRITICAL_95[Math.max(1, df)] : 1.96);

export function summarize(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = n > 1
    ? sorted.map((v) => (v - mean) ** 2).reduce((a, b) => a + b, 0) / (n - 1)
    : 0;
  const std = Math.sqrt(variance);
  const sem = std / Math.sqrt(n);
  const p95 = sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median,
    std,
    p95,
    ci95: tCritical(n - 1) * sem,
  };
}

export function geomean(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (clean.length === 0) return null;
  return Math.exp(clean.reduce((a, v) => a + Math.log(v), 0) / clean.length);
}
