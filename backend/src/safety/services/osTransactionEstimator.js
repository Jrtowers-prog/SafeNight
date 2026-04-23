/**
 * osTransactionEstimator.js — API-specific transaction conversion for OS APIs.
 *
 * Enforces OS transaction semantics:
 *   - Feature APIs: 1 txn per response up to 100 features
 *   - Tile/map APIs: measured as map views
 *   - OS Places: £0.01 per request (excluded from free £1,000 pool)
 *
 * Includes configurable safety margin to avoid race-condition overages.
 */

const CAP_SAFETY_THRESHOLD_PERCENT = Math.max(
  0,
  Math.min(100, Number(process.env.OS_CAP_SAFETY_THRESHOLD_PERCENT || 10)),
);

const PRICING = {
  'os-ngd-features': { gbpPerTransaction: 0.19 / 1000 }, // £0.00019 per feature txn
  'os-ngd-tiles': { gbpPerMapView: 0.0331 },
  'os-places': { gbpPerRequest: 0.01 },
};

const FEATURES_PER_TRANSACTION = 100;

/**
 * Estimate transactions for an OS NGD Features request.
 * Uses bbox area and urban/rural density heuristic.
 */
function estimateNgdFeatureTransactions(bbox, densityFactor = null) {
  const areaKm2 = bboxAreaKm2(bbox);
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return 1;

  // Default density: 300 features/km² (urban average)
  // Rural routes may be lower; caller can override
  const density = Number.isFinite(densityFactor) && densityFactor > 0
    ? densityFactor
    : 300;

  const estimatedFeatures = Math.ceil(areaKm2 * density);
  const transactions = Math.ceil(estimatedFeatures / FEATURES_PER_TRANSACTION);
  return Math.max(1, transactions);
}

/**
 * Estimate cost in GBP for a given API call.
 */
function estimateSpendGbp(api, transactionsOrViews) {
  const pricing = PRICING[api];
  if (!pricing) return 0;

  const count = Math.max(0, Number(transactionsOrViews) || 0);

  if (pricing.gbpPerTransaction) {
    return count * pricing.gbpPerTransaction;
  }
  if (pricing.gbpPerMapView) {
    return count * pricing.gbpPerMapView;
  }
  if (pricing.gbpPerRequest) {
    return count * pricing.gbpPerRequest;
  }
  return 0;
}

/**
 * Apply safety margin to projected cost.
 */
function applySafetyMargin(projectedCostGbp) {
  const multiplier = 1 + CAP_SAFETY_THRESHOLD_PERCENT / 100;
  return projectedCostGbp * multiplier;
}

/**
 * Confirm actual transactions after a response.
 * For feature APIs: ceil(featuresReturned / 100)
 */
function confirmFeatureTransactions(featuresReturned) {
  const count = Math.max(0, Number(featuresReturned) || 0);
  return Math.ceil(count / FEATURES_PER_TRANSACTION);
}

function bboxAreaKm2(bbox) {
  const { south, west, north, east } = bbox;
  if (!Number.isFinite(south) || !Number.isFinite(west) || !Number.isFinite(north) || !Number.isFinite(east)) {
    return 0;
  }
  const heightDeg = north - south;
  const widthDeg = east - west;
  if (heightDeg <= 0 || widthDeg <= 0) return 0;

  const midLat = (south + north) / 2;
  const heightKm = heightDeg * 111.32;
  const widthKm = widthDeg * 111.32 * Math.cos((midLat * Math.PI) / 180);
  return heightKm * widthKm;
}

module.exports = {
  estimateNgdFeatureTransactions,
  estimateSpendGbp,
  applySafetyMargin,
  confirmFeatureTransactions,
  bboxAreaKm2,
  PRICING,
  FEATURES_PER_TRANSACTION,
  CAP_SAFETY_THRESHOLD_PERCENT,
};
