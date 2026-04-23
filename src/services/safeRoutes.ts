/**
 * safeRoutes.ts — Frontend service for the safety-first pathfinding API.
 *
 * Calls the backend /api/safe-routes endpoint which builds an OSM walking
 * graph, scores edges using multiple safety factors (lighting, road type,
 * crime, open places, foot traffic), and returns 3–5 diverse routes ranked
 * by overall safety.
 */

import { env } from "@/src/config/env";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscriptionApi } from "@/src/services/userApi";
import { AppError } from "@/src/types/errors";
import type {
    DirectionsRoute,
    LatLng,
    NavigationStep,
    RouteSegment,
} from "@/src/types/geo";
import {
    emitLimitReached,
    LimitError,
    parseLimitResponse,
} from "@/src/types/limitError";
import { decodePolyline } from "@/src/utils/polyline";

const BACKEND_BASE = env.safetyApiUrl;
const AUTH_TOKEN_STORAGE_KEY = 'safenight_access_token';
const SEARCH_CLIENT_ID_STORAGE_KEY = 'safenight_search_client_id';

let requestSeqCounter = Date.now();
let searchClientIdPromise: Promise<string> | null = null;

function nextSearchSeq(): number {
  requestSeqCounter += 1;
  return requestSeqCounter;
}

function createSearchId(
  origin: LatLng,
  destination: LatLng,
  maxDistanceKm: number,
  waypoint?: LatLng | null,
): string {
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const wpLat = waypoint ? r4(waypoint.latitude) : 'x';
  const wpLng = waypoint ? r4(waypoint.longitude) : 'x';
  return `${r4(origin.latitude)},${r4(origin.longitude)}->${r4(destination.latitude)},${r4(destination.longitude)}@${wpLat},${wpLng}#${maxDistanceKm}`;
}

function makeClientId(): string {
  return `client:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

async function getSearchClientId(): Promise<string> {
  if (!searchClientIdPromise) {
    searchClientIdPromise = (async () => {
      const existing = await AsyncStorage.getItem(SEARCH_CLIENT_ID_STORAGE_KEY);
      if (existing && existing.trim()) return existing;
      const generated = makeClientId();
      await AsyncStorage.setItem(SEARCH_CLIENT_ID_STORAGE_KEY, generated);
      return generated;
    })();
  }

  try {
    return await searchClientIdPromise;
  } catch {
    searchClientIdPromise = null;
    return makeClientId();
  }
}

async function getAccessToken(): Promise<string | null> {
  const memoryToken = (globalThis as any).__safenight_access_token;
  if (typeof memoryToken === 'string' && memoryToken.trim()) return memoryToken;
  const storageToken = await AsyncStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  return storageToken && storageToken.trim() ? storageToken : null;
}

// ── Geo helper for bearing (used to detect turn direction) ───────────────────
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Bearing in degrees from point A → B (0 = north, 90 = east) */
const bearing = (a: LatLng, b: LatLng): number => {
  const dLng = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLng) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

/**
 * Build turn-by-turn NavigationSteps from enriched segments.
 *
 * Follows a familiar turn-by-turn navigation model:
 *  - Short initial stretches (<100 m) get merged into a single
 *    "Continue towards [first named road ahead]" step.
 *  - Each step instruction tells you what to do when you reach
 *    the step's endLocation.
 *  - Roundabout-like patterns (many rapid bearing changes in a
 *    short distance) become a single "At the roundabout, continue
 *    onto …" step.
 *  - Short unnamed junction gaps between the same named road are
 *    absorbed so the road appears unbroken.
 */
function buildStepsFromSegments(segments: EnrichedSegment[]): NavigationStep[] {
  if (!segments || segments.length === 0) return [];

  // ── 1. Group consecutive segments by road name ─────────────────────────
  type SegGroup = {
    roadName: string;
    segs: EnrichedSegment[];
    totalDist: number;
    highways: Set<string>;
  };

  const groups: SegGroup[] = [];
  let cur: SegGroup = {
    roadName: segments[0].roadName || "",
    segs: [segments[0]],
    totalDist: segments[0].distance,
    highways: new Set([segments[0].highway]),
  };
  for (let i = 1; i < segments.length; i++) {
    const name = segments[i].roadName || "";
    // Only group if BOTH have a non-empty matching name
    if (name !== "" && name === cur.roadName) {
      cur.segs.push(segments[i]);
      cur.totalDist += segments[i].distance;
      cur.highways.add(segments[i].highway);
    } else {
      groups.push(cur);
      cur = {
        roadName: name,
        segs: [segments[i]],
        totalDist: segments[i].distance,
        highways: new Set([segments[i].highway]),
      };
    }
  }
  groups.push(cur);

  // ── 2a. Merge consecutive unnamed groups ───────────────────────────────
  for (let g = 1; g < groups.length; g++) {
    if (!groups[g].roadName && !groups[g - 1].roadName) {
      groups[g - 1].segs.push(...groups[g].segs);
      groups[g - 1].totalDist += groups[g].totalDist;
      for (const h of groups[g].highways) groups[g - 1].highways.add(h);
      groups.splice(g, 1);
      g--;
    }
  }

  // ── 2b. Merge short unnamed junction connectors (<50 m) between
  //        the same named road ────────────────────────────────────────────
  for (let g = 1; g < groups.length - 1; g++) {
    if (
      !groups[g].roadName &&
      groups[g].totalDist < 50 &&
      groups[g - 1].roadName &&
      groups[g - 1].roadName === groups[g + 1].roadName
    ) {
      groups[g - 1].segs.push(...groups[g].segs, ...groups[g + 1].segs);
      groups[g - 1].totalDist += groups[g].totalDist + groups[g + 1].totalDist;
      for (const h of groups[g].highways) groups[g - 1].highways.add(h);
      for (const h of groups[g + 1].highways) groups[g - 1].highways.add(h);
      groups.splice(g, 2);
      g--;
    }
  }

  // ── 2c. Merge leading short groups (<100 m total) ─────────────────────
  //    Turn-by-turn apps don't show "In 3 m turn right" when you're basically
  //    already at the road. It merges them into one initial step like
  //    "Continue towards [first meaningful road ahead]".
  while (groups.length >= 2 && groups[0].totalDist < 100) {
    groups[0].segs.push(...groups[1].segs);
    groups[0].totalDist += groups[1].totalDist;
    // Take the first meaningful name
    if (!groups[0].roadName && groups[1].roadName) {
      groups[0].roadName = groups[1].roadName;
    }
    for (const h of groups[1].highways) groups[0].highways.add(h);
    groups.splice(1, 1);
    // Stop once we've exceeded 100 m — don't swallow the whole route
    if (groups[0].totalDist >= 100) break;
  }

  // ── 2d. Detect roundabouts: a short group (<80 m) with ≥3 segments
  //        and a large total bearing change is a roundabout ───────────────
  const isRoundabout = (grp: SegGroup): boolean => {
    if (grp.segs.length < 3 || grp.totalDist > 80) return false;
    let totalTurn = 0;
    for (let i = 1; i < grp.segs.length; i++) {
      const brg1 = bearing(
        {
          latitude: grp.segs[i - 1].startCoord.latitude,
          longitude: grp.segs[i - 1].startCoord.longitude,
        },
        {
          latitude: grp.segs[i - 1].endCoord.latitude,
          longitude: grp.segs[i - 1].endCoord.longitude,
        },
      );
      const brg2 = bearing(
        {
          latitude: grp.segs[i].startCoord.latitude,
          longitude: grp.segs[i].startCoord.longitude,
        },
        {
          latitude: grp.segs[i].endCoord.latitude,
          longitude: grp.segs[i].endCoord.longitude,
        },
      );
      let d = brg2 - brg1;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      totalTurn += Math.abs(d);
    }
    // A roundabout traversal typically turns ≥120° across ≥3 segments
    return totalTurn >= 120;
  };

  // ── 3. Build forward-looking steps ─────────────────────────────────────
  const steps: NavigationStep[] = [];

  /** Find the next named road from group index g onward (for "towards") */
  const findNextNamedRoad = (fromG: number): string => {
    for (let g = fromG; g < groups.length; g++) {
      if (groups[g].roadName) return groups[g].roadName;
    }
    return "";
  };

  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    const firstSeg = grp.segs[0];
    const lastSeg = grp.segs[grp.segs.length - 1];

    let instruction: string;
    let maneuver: string;

    if (g === groups.length - 1) {
      // Last group → arrive
      instruction = "Arrive at your destination";
      maneuver = "straight";
    } else {
      const nextGrp = groups[g + 1];
      const nextFirst = nextGrp.segs[0];

      // Check if the next group is a roundabout
      const nextIsRoundabout = isRoundabout(nextGrp);

      // Approach bearing = direction of last segment in current group
      const approachBrg = bearing(
        {
          latitude: lastSeg.startCoord.latitude,
          longitude: lastSeg.startCoord.longitude,
        },
        {
          latitude: lastSeg.endCoord.latitude,
          longitude: lastSeg.endCoord.longitude,
        },
      );
      // Departure bearing = direction of first segment of next group
      const departBrg = bearing(
        {
          latitude: nextFirst.startCoord.latitude,
          longitude: nextFirst.startCoord.longitude,
        },
        {
          latitude: nextFirst.endCoord.latitude,
          longitude: nextFirst.endCoord.longitude,
        },
      );

      let diff = departBrg - approachBrg;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;

      const nextRoad = nextGrp.roadName;

      if (nextIsRoundabout) {
        // Find which road comes AFTER the roundabout
        const afterRoundabout = findNextNamedRoad(g + 2);
        maneuver = "roundabout-right";
        instruction = afterRoundabout
          ? `At the roundabout, continue onto ${afterRoundabout}`
          : "Continue on the roundabout";
      } else if (g === 0) {
        // First step: "Continue towards [first landmark ahead]"
        const towards = findNextNamedRoad(g + 1);
        maneuver = "straight";
        instruction = towards
          ? `Continue towards ${towards}`
          : "Continue on route";
      } else if (diff > 30 && diff <= 70) {
        maneuver = "turn-slight-right";
        instruction = `Turn slight right${nextRoad ? " onto " + nextRoad : ""}`;
      } else if (diff > 70 && diff <= 150) {
        maneuver = "turn-right";
        instruction = `Turn right${nextRoad ? " onto " + nextRoad : ""}`;
      } else if (diff > 150) {
        maneuver = "turn-sharp-right";
        instruction = `Turn sharp right${nextRoad ? " onto " + nextRoad : ""}`;
      } else if (diff < -30 && diff >= -70) {
        maneuver = "turn-slight-left";
        instruction = `Turn slight left${nextRoad ? " onto " + nextRoad : ""}`;
      } else if (diff < -70 && diff >= -150) {
        maneuver = "turn-left";
        instruction = `Turn left${nextRoad ? " onto " + nextRoad : ""}`;
      } else if (diff < -150) {
        maneuver = "turn-sharp-left";
        instruction = `Turn sharp left${nextRoad ? " onto " + nextRoad : ""}`;
      } else {
        maneuver = "straight";
        instruction = nextRoad ? `Continue onto ${nextRoad}` : "Continue";
      }
    }

    // Skip roundabout groups as standalone steps — they were already
    // referenced by the preceding step's instruction.
    if (isRoundabout(grp) && steps.length > 0) {
      // Absorb the roundabout distance/geometry into the previous step
      const prev = steps[steps.length - 1];
      prev.distanceMeters += Math.round(grp.totalDist);
      prev.durationSeconds += Math.round(grp.totalDist / 1.4);
      prev.endLocation = {
        latitude: lastSeg.endCoord.latitude,
        longitude: lastSeg.endCoord.longitude,
      };
      continue;
    }

    steps.push({
      instruction,
      distanceMeters: Math.round(grp.totalDist),
      durationSeconds: Math.round(grp.totalDist / 1.4),
      startLocation: {
        latitude: firstSeg.startCoord.latitude,
        longitude: firstSeg.startCoord.longitude,
      },
      endLocation: {
        latitude: lastSeg.endCoord.latitude,
        longitude: lastSeg.endCoord.longitude,
      },
      maneuver,
    });
  }

  return steps;
}

// ── Subscription tier distance limits (fallback only — prefer DB value) ──────
const DISTANCE_LIMITS_KM: Record<string, number> = {
  free: 3, // 3 km for free users
  pro: 10, // 10 km for pro users
  premium: 20, // 20 km for premium users
};

/** Fallback: compute limit from tier when DB value is not available */
export function getMaxDistanceKmForTier(tier: string): number {
  return DISTANCE_LIMITS_KM[tier?.toLowerCase()] ?? DISTANCE_LIMITS_KM.free;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SafetyBreakdown {
  roadType: number; // 0-100
  lighting: number; // 0-100
  crime: number; // 0-100 (higher = safer)
  cctv: number; // 0-100 (CCTV/surveillance coverage)
  openPlaces: number; // 0-100
  traffic: number; // 0-100
}

export interface RouteSafety {
  score: number; // 0-100
  label: string; // "Very Safe" | "Safe" | "Moderate" | "Use Caution"
  color: string; // hex colour
  breakdown: SafetyBreakdown;
  roadTypes: Record<string, number>; // e.g. { primary: 40, residential: 35, footway: 25 }
  mainRoadRatio: number; // 0-100
}

export interface SafeRoute extends DirectionsRoute {
  routeIndex: number;
  isSafest: boolean;
  safety: RouteSafety;
  safetySegments: RouteSegment[];
  enrichedSegments?: EnrichedSegment[];
  routeStats?: RouteStats;
  routePOIs?: RoutePOIs;
  queryFootprints?: Array<{
    cellKey?: string;
    south: number;
    west: number;
    north: number;
    east: number;
    centerLat?: number;
    centerLng?: number;
    segmentCount?: number;
    status?: string;
  }>;
  lightUncertaintySpans?: Array<{
    start: { lat: number; lng: number };
    end: { lat: number; lng: number };
    edgeCount?: number;
    distance?: number;
    reason?: string;
    confidence?: number;
  }>;
  generalUncertaintyBoxes?: Array<{
    south: number;
    west: number;
    north: number;
    east: number;
    reason?: string;
    edgeCount?: number;
    distance?: number;
    confidence?: number;
  }>;
  uncertaintyBoxes?: Array<{ south: number; west: number; north: number; east: number }>;
}

export interface RouteStats {
  deadEnds: number;
  sidewalkPct: number;
  unpavedPct: number;
  transitStopsNearby: number;
  cctvCamerasNearby: number;
  roadNameChanges: Array<{
    segmentIndex: number;
    name: string;
    distance: number;
  }>;
}

export interface RoutePOIs {
  cctv: Array<{ lat: number; lng: number }>;
  transit: Array<{ lat: number; lng: number }>;
  deadEnds: Array<{ lat: number; lng: number }>;
  lights: Array<{ lat: number; lng: number }>;
  places: Array<{ lat: number; lng: number }>;
  crimes: Array<{ lat: number; lng: number; category?: string }>;
}

export interface EnrichedSegment {
  startCoord: { latitude: number; longitude: number };
  endCoord: { latitude: number; longitude: number };
  midpointCoord: { latitude: number; longitude: number };
  safetyScore: number;
  color: string;
  highway: string;
  roadName: string;
  isDeadEnd: boolean;
  hasSidewalk: boolean;
  surfaceType: string;
  lightScore: number;
  crimeScore: number;
  cctvScore: number;
  placeScore: number;
  trafficScore: number;
  distance: number;
}

export interface SafeRoutesResponse {
  status: string;
  routes: SafeRoute[];
  meta: {
    straightLineDistanceKm: number;
    maxDistanceKm: number;
    routeCount: number;
    dataQuality: {
      roads: number;
      crimes: number;
      lightElements: number;
      cctvCameras: number;
      places: number;
      transitStops: number;
    };
    timing: {
      totalMs: number;
      dataFetchMs: number;
      graphBuildMs: number;
      pathfindMs: number;
    };
    computeTimeMs: number;
  };
  error?: string;
  message?: string;
}

// ── API response shape (before mapping) ─────────────────────────────────────

interface RawSafeRouteSegment {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  safetyScore: number;
  color: string;
  highway: string;
  roadName?: string;
  isDeadEnd?: boolean;
  hasSidewalk?: boolean;
  surfaceType?: string;
  lightScore?: number;
  crimeScore?: number;
  cctvScore?: number;
  placeScore?: number;
  trafficScore?: number;
  distance?: number;
}

interface RawSafeRoute {
  routeIndex: number;
  isSafest: boolean;
  overview_polyline: { points: string };
  legs: Array<{
    distance: { text: string; value: number };
    duration: { text: string; value: number };
    start_location: { lat: number; lng: number };
    end_location: { lat: number; lng: number };
    steps: Array<unknown>;
  }>;
  summary: string;
  safety: {
    score: number;
    label: string;
    color: string;
    breakdown: SafetyBreakdown;
    roadTypes: Record<string, number>;
    mainRoadRatio: number;
  };
  segments: RawSafeRouteSegment[];
  routeStats?: {
    deadEnds: number;
    sidewalkPct: number;
    unpavedPct: number;
    transitStopsNearby: number;
    cctvCamerasNearby: number;
    roadNameChanges: Array<{
      segmentIndex: number;
      name: string;
      distance: number;
    }>;
  };
  routePOIs?: {
    cctv: Array<{ lat: number; lng: number }>;
    transit: Array<{ lat: number; lng: number }>;
    deadEnds: Array<{ lat: number; lng: number }>;
    lights: Array<{ lat: number; lng: number }>;
    places: Array<{ lat: number; lng: number }>;
    crimes: Array<{ lat: number; lng: number; category?: string }>;
  };
  queryFootprints?: Array<{
    cellKey?: string;
    south: number;
    west: number;
    north: number;
    east: number;
    centerLat?: number;
    centerLng?: number;
    segmentCount?: number;
    status?: string;
  }>;
  lightUncertaintySpans?: Array<{
    start: { lat: number; lng: number };
    end: { lat: number; lng: number };
    edgeCount?: number;
    distance?: number;
    reason?: string;
    confidence?: number;
  }>;
  generalUncertaintyBoxes?: Array<{
    south: number;
    west: number;
    north: number;
    east: number;
    reason?: string;
    edgeCount?: number;
    distance?: number;
    confidence?: number;
  }>;
  uncertaintyBoxes?: Array<{ south: number; west: number; north: number; east: number }>;
}

interface RawResponse {
  status: string;
  routes?: RawSafeRoute[];
  meta?: SafeRoutesResponse["meta"];
  error?: string;
  message?: string;
  detail?: string;
  // Extra fields from specific error responses
  estimatedDataPoints?: number;
  areaKm2?: number;
  maxDistanceKm?: number;
  actualDistanceKm?: number;
  graphNodes?: number;
  graphEdges?: number;
  roadCount?: number;
  which?: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: SafeRoutesResponse;
  timestamp: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000;

function cacheKey(
  origin: LatLng,
  dest: LatLng,
  waypoint?: LatLng | null,
): string {
  const base = `${origin.latitude.toFixed(4)},${origin.longitude.toFixed(4)}->${dest.latitude.toFixed(4)},${dest.longitude.toFixed(4)}`;
  return waypoint
    ? `${base}@${waypoint.latitude.toFixed(4)},${waypoint.longitude.toFixed(4)}`
    : base;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Fetch 3–5 safety-ranked walking routes from the backend.
 *
 * @throws AppError with code 'DESTINATION_OUT_OF_RANGE' if > 20 km
 * @throws AppError with code 'safe_routes_error' on other failures
 */
export async function fetchSafeRoutes(
  origin: LatLng,
  destination: LatLng,
  subscriptionTier: string = "free",
  maxDistanceKmOverride?: number,
  waypoint?: LatLng | null,
): Promise<SafeRoutesResponse> {
  await subscriptionApi.ensureFeatureAllowed("route_search");

  const key = cacheKey(origin, destination, waypoint);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log("[safeRoutes] 📋 Cache hit");
    return cached.data;
  }

  // Use the DB-driven override if provided, otherwise fall back to hardcoded tier lookup
  const maxDistanceKm =
    maxDistanceKmOverride ?? getMaxDistanceKmForTier(subscriptionTier);
  const waypointParam = waypoint
    ? `&waypoint_lat=${waypoint.latitude}&waypoint_lng=${waypoint.longitude}`
    : "";
  const url =
    `${BACKEND_BASE}/api/safe-routes?` +
    `origin_lat=${origin.latitude}&origin_lng=${origin.longitude}` +
    `&dest_lat=${destination.latitude}&dest_lng=${destination.longitude}` +
    `&max_distance=${maxDistanceKm}${waypointParam}`;

  if (waypoint) {
    console.log(
      `[safeRoutes] 📍 Via waypoint: ${waypoint.latitude.toFixed(4)},${waypoint.longitude.toFixed(4)}`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000); // 120s timeout (cold-start + two-phase pipeline)

  try {
    const [token, searchClientId] = await Promise.all([
      getAccessToken(),
      getSearchClientId(),
    ]);
    const searchSeq = nextSearchSeq();
    const searchId = createSearchId(origin, destination, maxDistanceKm, waypoint);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Search-Id': searchId,
      'X-Search-Client': searchClientId,
      'X-Search-Seq': String(searchSeq),
    };

    if (token) headers.Authorization = `Bearer ${token}`;

    const resp = await fetch(url, { signal: controller.signal, headers });
    console.log(
      `[safeRoutes] ✅ Got response: ${resp.status} ${resp.statusText}`,
    );
    clearTimeout(timer);

    const raw: RawResponse = await resp.json();
    console.log(
      `[safeRoutes] ✅ Parsed JSON - routes: ${raw.routes?.length || 0}`,
    );

    if (!resp.ok) {
      // Check for subscription limit error (403)
      if (resp.status === 403) {
        const limitInfo = parseLimitResponse(raw as any);
        if (limitInfo) {
          await subscriptionApi.syncFromLimitInfo(limitInfo);
          emitLimitReached(limitInfo);
          throw new LimitError(limitInfo);
        }
      }

      // Collect all extra fields from the backend into a details object
      const details: Record<string, unknown> = {};
      if (raw.detail) details.detail = raw.detail;
      if (raw.estimatedDataPoints)
        details.estimatedDataPoints = raw.estimatedDataPoints;
      if (raw.areaKm2) details.areaKm2 = raw.areaKm2;
      if (raw.maxDistanceKm) details.maxDistanceKm = raw.maxDistanceKm;
      if (raw.actualDistanceKm) details.actualDistanceKm = raw.actualDistanceKm;
      if (raw.graphNodes) details.graphNodes = raw.graphNodes;
      if (raw.graphEdges) details.graphEdges = raw.graphEdges;
      if (raw.roadCount != null) details.roadCount = raw.roadCount;
      if (raw.which) details.which = raw.which;

      if (raw.error === "DESTINATION_OUT_OF_RANGE") {
        throw new AppError(
          "DESTINATION_OUT_OF_RANGE",
          raw.message ||
            "Destination is too far away. Maximum walking distance is 6 miles.",
          undefined,
          details,
        );
      }
      if (raw.error === "NO_ROUTE_FOUND") {
        throw new AppError(
          "NO_ROUTE_FOUND",
          raw.message || "No walking route found between these points.",
          undefined,
          details,
        );
      }
      if (raw.error === "NO_NEARBY_ROAD") {
        throw new AppError(
          "NO_NEARBY_ROAD",
          raw.message || "No walkable road found near one of your locations.",
          undefined,
          details,
        );
      }
      throw new AppError(
        raw.error || "safe_routes_error",
        raw.message || `Server returned ${resp.status}`,
        undefined,
        details,
      );
    }

    if (raw.status !== "OK" || !raw.routes || raw.routes.length === 0) {
      throw new AppError(
        "safe_routes_no_results",
        raw.message || "No safe routes found between these points.",
      );
    }

    // Map raw response into our typed SafeRoute objects
    const routes: SafeRoute[] = raw.routes.map((r, idx) => {
      const encoded = r.overview_polyline?.points ?? "";
      const path = decodePolyline(encoded);
      const leg = r.legs?.[0];

      // Map raw segments to RouteSegment type
      const safetySegments: RouteSegment[] = (r.segments || []).map((seg) => ({
        startCoord: { latitude: seg.start.lat, longitude: seg.start.lng },
        endCoord: { latitude: seg.end.lat, longitude: seg.end.lng },
        midpointCoord: {
          latitude: (seg.start.lat + seg.end.lat) / 2,
          longitude: (seg.start.lng + seg.end.lng) / 2,
        },
        distanceMeters: seg.distance ?? 0,
        lightingScore:
          seg.lightScore ?? (r.safety?.breakdown?.lighting ?? 0) / 100,
        crimeScore: seg.crimeScore ?? (r.safety?.breakdown?.crime ?? 0) / 100,
        activityScore: (r.safety?.breakdown?.openPlaces ?? 0) / 100,
        combinedScore: seg.safetyScore,
        color: seg.color,
      }));

      // Map enriched segments for the chart
      const enrichedSegments: EnrichedSegment[] = (r.segments || []).map(
        (seg) => ({
          startCoord: { latitude: seg.start.lat, longitude: seg.start.lng },
          endCoord: { latitude: seg.end.lat, longitude: seg.end.lng },
          midpointCoord: {
            latitude: (seg.start.lat + seg.end.lat) / 2,
            longitude: (seg.start.lng + seg.end.lng) / 2,
          },
          safetyScore: seg.safetyScore,
          color: seg.color,
          highway: seg.highway,
          roadName: seg.roadName ?? "",
          isDeadEnd: seg.isDeadEnd ?? false,
          hasSidewalk: seg.hasSidewalk ?? false,
          surfaceType: seg.surfaceType ?? "paved",
          lightScore: seg.lightScore ?? 0,
          crimeScore: seg.crimeScore ?? 0,
          cctvScore: seg.cctvScore ?? 0,
          placeScore: seg.placeScore ?? 0,
          trafficScore: seg.trafficScore ?? 0,
          distance: seg.distance ?? 0,
        }),
      );

      return {
        id: `safe-route-${idx}`,
        routeIndex: r.routeIndex,
        isSafest: r.isSafest,
        distanceMeters: leg?.distance?.value ?? 0,
        durationSeconds: leg?.duration?.value ?? 0,
        encodedPolyline: encoded,
        path,
        summary: r.summary,
        steps: buildStepsFromSegments(enrichedSegments),
        segments: safetySegments,
        safetySegments,
        enrichedSegments,
        safety: r.safety,
        routeStats: r.routeStats,
        routePOIs: r.routePOIs,
        queryFootprints: r.queryFootprints,
        lightUncertaintySpans: r.lightUncertaintySpans,
        generalUncertaintyBoxes: r.generalUncertaintyBoxes,
        uncertaintyBoxes: r.uncertaintyBoxes,
      };
    });

    const result: SafeRoutesResponse = {
      status: "OK",
      routes,
      meta: raw.meta!,
    };

    await subscriptionApi.consume("route_search");

    cache.set(key, { data: result, timestamp: Date.now() });
    console.log(
      `[safeRoutes] ✅ ${routes.length} routes, safest: ${routes[0]?.safety?.score}/100 "${routes[0]?.safety?.label}"`,
    );
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof AppError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new AppError(
        "safe_routes_timeout",
        "Safe routes request timed out. Please try again.",
      );
    }
    throw new AppError("safe_routes_error", "Failed to fetch safe routes", err);
  }
}
