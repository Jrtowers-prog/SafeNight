import { useEffect, useMemo, useRef, useState } from "react";

import type { NavigationInfo } from "@/src/hooks/useNavigation";
import type { SafeRoute } from "@/src/services/safeRoutes";
import { stripHtml } from "@/src/utils/format";

export type NavAlertKind = "crime" | "cctv" | "street";

export interface NavAlert {
  key: string;
  kind: NavAlertKind;
  text: string;
}

type NavAlertCandidate = NavAlert & {
  priority: number;
  distanceMeters: number;
};

interface UseNavAlertsInput {
  nav: NavigationInfo;
  selectedSafeRoute: SafeRoute | null;
  cooldownMs?: number;
}

const ALERT_DISTANCE_AHEAD_M = 140;
const AHEAD_ANGLE_TOLERANCE_DEG = 70;
const DEFAULT_COOLDOWN_MS = 12_000;

const toRadians = (value: number) => (value * Math.PI) / 180;

const haversine = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) => {
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const aa =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const cc = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return earthRadiusMeters * cc;
};

const bearing = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) => {
  const dLng = toRadians(b.longitude - a.longitude);
  const y = Math.sin(dLng) * Math.cos(toRadians(b.latitude));
  const x =
    Math.cos(toRadians(a.latitude)) * Math.sin(toRadians(b.latitude)) -
    Math.sin(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const headingDelta = (a: number, b: number) => {
  let delta = a - b;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return Math.abs(delta);
};

const toTitle = (value: string) =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const extractStreetFromInstruction = (instruction?: string | null) => {
  if (!instruction) return null;
  const text = stripHtml(instruction);
  const onMatch = text.match(/\b(?:onto|on)\s+([^,.;]+)/i);
  if (onMatch?.[1]) return onMatch[1].trim();
  const towardMatch = text.match(/\b(?:towards|toward|to)\s+([^,.;]+)/i);
  if (towardMatch?.[1]) return towardMatch[1].trim();
  return null;
};

const pickNearestSegmentRoad = (
  route: SafeRoute,
  userLocation: { latitude: number; longitude: number },
) => {
  if (!route.enrichedSegments?.length) return null;
  let nearestRoad: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const segment of route.enrichedSegments) {
    if (!segment.roadName) continue;
    const distance = haversine(userLocation, segment.midpointCoord);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRoad = segment.roadName;
    }
  }
  return nearestRoad;
};

const isAhead = (
  userLocation: { latitude: number; longitude: number },
  poi: { latitude: number; longitude: number },
  directionHeading: number,
) => {
  const distance = haversine(userLocation, poi);
  if (distance > ALERT_DISTANCE_AHEAD_M) return false;
  const headingToPoi = bearing(userLocation, poi);
  return headingDelta(headingToPoi, directionHeading) <= AHEAD_ANGLE_TOLERANCE_DEG;
};

export function useNavAlerts({
  nav,
  selectedSafeRoute,
  cooldownMs = DEFAULT_COOLDOWN_MS,
}: UseNavAlertsInput): NavAlert | null {
  const isNavActive = nav.state === "navigating" || nav.state === "off-route";
  const [visibleAlert, setVisibleAlert] = useState<NavAlert | null>(null);
  const seenAtRef = useRef<Map<string, number>>(new Map());

  const nextAlert = useMemo<NavAlert | null>(() => {
    if (!isNavActive || !selectedSafeRoute) return null;

    const streetFromStep = extractStreetFromInstruction(nav.currentStep?.instruction);
    const streetName =
      streetFromStep ||
      (nav.userLocation
        ? pickNearestSegmentRoad(selectedSafeRoute, nav.userLocation)
        : null);

    const candidates: NavAlertCandidate[] = [];
    const userLocation = nav.userLocation;
    const heading =
      nav.userHeading ??
      (nav.currentStep
        ? bearing(nav.currentStep.startLocation, nav.currentStep.endLocation)
        : null);

    if (selectedSafeRoute.routePOIs && userLocation && heading != null) {
      for (const crime of selectedSafeRoute.routePOIs.crimes ?? []) {
        const point = { latitude: crime.lat, longitude: crime.lng };
        if (!isAhead(userLocation, point, heading)) continue;
        const distanceMeters = haversine(userLocation, point);
        const category = crime.category ? toTitle(crime.category) : null;
        candidates.push({
          key: `crime:${Math.round(crime.lat * 1e5)}:${Math.round(crime.lng * 1e5)}:${category ?? "unknown"}`,
          kind: "crime",
          text: category
            ? `Crime reported ahead (${category})`
            : "Crime reported ahead",
          priority: 3,
          distanceMeters,
        });
      }

      for (const cctv of selectedSafeRoute.routePOIs.cctv ?? []) {
        const point = { latitude: cctv.lat, longitude: cctv.lng };
        if (!isAhead(userLocation, point, heading)) continue;
        candidates.push({
          key: `cctv:${Math.round(cctv.lat * 1e5)}:${Math.round(cctv.lng * 1e5)}`,
          kind: "cctv",
          text: "CCTV monitoring ahead",
          priority: 2,
          distanceMeters: haversine(userLocation, point),
        });
      }
    }

    if (streetName) {
      candidates.push({
        key: `street:${streetName.toLowerCase()}`,
        kind: "street",
        text: `On ${streetName}`,
        priority: 1,
        distanceMeters: 0,
      });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.distanceMeters - b.distanceMeters;
    });
    const best = candidates[0];
    return { key: best.key, kind: best.kind, text: best.text };
  }, [
    isNavActive,
    nav.currentStep,
    nav.userHeading,
    nav.userLocation,
    selectedSafeRoute,
  ]);

  useEffect(() => {
    if (!isNavActive || !nextAlert) {
      setVisibleAlert(null);
      return;
    }

    // Alert algorithm plan:
    // 1) Build candidates from POIs ahead + current street context.
    // 2) Rank by priority: crime > CCTV > street.
    // 3) Keep one alert visible and avoid rapid repeats with seen keys + cooldown.
    const now = Date.now();
    const alreadySeenAt = seenAtRef.current.get(nextAlert.key) ?? 0;

    if (visibleAlert?.key === nextAlert.key) {
      setVisibleAlert(nextAlert);
      return;
    }

    if (now - alreadySeenAt < cooldownMs && visibleAlert) {
      return;
    }

    seenAtRef.current.set(nextAlert.key, now);
    if (seenAtRef.current.size > 24) {
      const entries = [...seenAtRef.current.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - 24; i++) {
        seenAtRef.current.delete(entries[i][0]);
      }
    }
    setVisibleAlert(nextAlert);
  }, [cooldownMs, isNavActive, nextAlert, visibleAlert]);

  return visibleAlert;
}
