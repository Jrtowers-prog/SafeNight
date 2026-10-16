import AsyncStorage from "@react-native-async-storage/async-storage";

import { env } from "@/src/config/env";
import type { LatLng } from "@/src/types/geo";

const ACCESS_TOKEN_KEY = "safenight_access_token";
const SHARE_TIMEOUT_MS = 12_000;
const SHARE_WEB_BASE_URL = (process.env.EXPO_PUBLIC_SHARE_WEB_BASE_URL || "").trim();

export type ShareRouteCreatePayload = {
  destinationName?: string;
  destination?: LatLng;
  routePath?: LatLng[];
  expiresInHours?: number;
  redactOrigin?: boolean;
};

export type ShareRouteCreateResponse = {
  token: string;
  shareUrl: string;
  expiresAt: string;
};

export type ShareRouteResolveResponse = {
  token: string;
  destinationName?: string;
  destination?: LatLng;
  routePath?: LatLng[];
  expiresAt: string;
  createdAt: string;
};

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = SHARE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Request timed out"), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

function buildWebShareUrl(token: string): string {
  const safeToken = encodeURIComponent(token);
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin.replace(/\/$/, "")}/share/${safeToken}`;
  }
  if (SHARE_WEB_BASE_URL) {
    return `${SHARE_WEB_BASE_URL.replace(/\/$/, "")}/share/${safeToken}`;
  }
  return "";
}

export async function createRouteShareLink(
  payload: ShareRouteCreatePayload,
): Promise<ShareRouteCreateResponse> {
  const token = await AsyncStorage.getItem(ACCESS_TOKEN_KEY);

  const response = await fetchWithTimeout(`${env.userApiUrl}/api/shares`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || "Failed to create route share link");
  }

  const tokenValue = String(body?.token || "");
  const rawShareUrl = String(body?.shareUrl || "");
  const webShareUrl = tokenValue ? buildWebShareUrl(tokenValue) : "";
  const rawIsHttpUrl = /^https?:\/\//i.test(rawShareUrl);
  const normalizedShareUrl = webShareUrl || (rawIsHttpUrl ? rawShareUrl : "") || rawShareUrl;

  return {
    token: tokenValue,
    shareUrl: normalizedShareUrl,
    expiresAt: String(body?.expiresAt || ""),
  };
}

export async function resolveRouteShareLink(token: string): Promise<ShareRouteResolveResponse> {
  const response = await fetchWithTimeout(`${env.userApiUrl}/api/shares/${encodeURIComponent(token)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || "Failed to resolve route share link");
  }

  return {
    token: String(body?.token || ""),
    destinationName: body?.destinationName ? String(body.destinationName) : undefined,
    destination: body?.destination
      ? {
          latitude: Number(body.destination.latitude),
          longitude: Number(body.destination.longitude),
        }
      : undefined,
    routePath: Array.isArray(body?.routePath)
      ? body.routePath
          .map((point: any) => ({
            latitude: Number(point?.latitude),
            longitude: Number(point?.longitude),
          }))
          .filter((point: LatLng) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
      : undefined,
    expiresAt: String(body?.expiresAt || ""),
    createdAt: String(body?.createdAt || ""),
  };
}
