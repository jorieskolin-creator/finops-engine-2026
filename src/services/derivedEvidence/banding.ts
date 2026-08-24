export const BANDING_VERSION = '1.0.0' as const;

export type CoverageBand = '0_25' | '25_50' | '50_75' | '75_90' | '90_100';
export const coverageBand = (percentValue: number): CoverageBand => {
  if (percentValue < 25) return '0_25';
  if (percentValue < 50) return '25_50';
  if (percentValue < 75) return '50_75';
  if (percentValue < 90) return '75_90';
  return '90_100';
};

export type MagnitudeBand = 'LT_5_PERCENT' | '5_10' | '10_20' | '20_50' | 'GT_50';
export const magnitudeBand = (relative: number): MagnitudeBand => {
  const magnitude = Math.abs(relative);
  if (magnitude < 0.05) return 'LT_5_PERCENT';
  if (magnitude < 0.10) return '5_10';
  if (magnitude < 0.20) return '10_20';
  if (magnitude < 0.50) return '20_50';
  return 'GT_50';
};

export type VariabilityBand = 'LOW' | 'MODERATE' | 'HIGH';
export const variabilityBand = (cv: number): VariabilityBand => {
  if (!Number.isFinite(cv) || cv > 0.30) return 'HIGH';
  if (cv < 0.10) return 'LOW';
  return 'MODERATE';
};

export type PersistenceBand = 'SUSTAINED' | 'INTERMITTENT' | 'SINGLE_PERIOD';
export const persistenceBand = (alignedCount: number, n: number): PersistenceBand => {
  if (n <= 1) return 'SINGLE_PERIOD';
  if (n >= 6 && alignedCount >= 5) return 'SUSTAINED';
  if (alignedCount <= 1) return 'SINGLE_PERIOD';
  return 'INTERMITTENT';
};

export type ConcentrationBand = 'EVEN' | 'MODERATE' | 'HIGH';
export const concentrationBandFromHhi = (hhi: number): ConcentrationBand => {
  if (hhi < 0.15) return 'EVEN';
  if (hhi <= 0.25) return 'MODERATE';
  return 'HIGH';
};

export type AgingBand = 'LT_7D' | '7_30D' | '30_90D' | 'GT_90D' | 'NOT_AVAILABLE';
export const agingBand = (days: number | null): AgingBand => {
  if (days === null || !Number.isFinite(days)) return 'NOT_AVAILABLE';
  if (days < 7) return 'LT_7D';
  if (days < 30) return '7_30D';
  if (days < 90) return '30_90D';
  return 'GT_90D';
};

export type CadenceBand = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'AD_HOC' | 'UNKNOWN';
export const cadenceBand = (medianDays: number | null): CadenceBand => {
  if (medianDays === null || !Number.isFinite(medianDays) || medianDays <= 0) return 'UNKNOWN';
  if (medianDays <= 10) return 'WEEKLY';
  if (medianDays <= 40) return 'MONTHLY';
  if (medianDays <= 100) return 'QUARTERLY';
  return 'AD_HOC';
};

export type AssociationStrength = 'NO_MATERIAL_ASSOCIATION' | 'WEAK' | 'MODERATE' | 'STRONG';
export const associationStrength = (r: number): AssociationStrength => {
  const magnitude = Math.abs(r);
  if (magnitude < 0.3) return 'NO_MATERIAL_ASSOCIATION';
  if (magnitude < 0.6) return 'WEAK';
  if (magnitude < 0.8) return 'MODERATE';
  return 'STRONG';
};

export type ReachBand = 'NARROW' | 'PARTIAL' | 'BROAD';
export const organizationalReach = (percentValue: number): ReachBand => {
  if (percentValue < 40) return 'NARROW';
  if (percentValue < 75) return 'PARTIAL';
  return 'BROAD';
};


