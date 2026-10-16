/**
 * usePathfindingVisualization.ts — Real-time pathfinding progress for map visualisation.
 *
 * Connects to the backend SSE stream at /api/safe-routes/stream during route search
 * and accumulates all progress events (bboxes, data points, corridor, scoring, routes)
 * into state that the map can render with animated overlays.
 *
 * Uses XMLHttpRequest (not fetch) because React Native's fetch does NOT
 * support ReadableStream / response.body — XHR's onprogress fires progressively.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { env } from '@/src/config/env';
import type { LatLng } from '@/src/types/geo';

const BACKEND_BASE = env.safetyApiUrl;
const AUTH_TOKEN_STORAGE_KEY = 'safenight_access_token';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BboxRect {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface VisPhase {
  phase: string;
  message: string;
  pct: number;
}

export interface VisBbox {
  phase: string;
  bbox: BboxRect;
  bufferM: number;
  message: string;
  pct: number;
}

export interface VisDataPoints {
  kind: 'road_network' | 'lights' | 'cctv' | 'crimes' | 'places' | 'transit';
  count: number;
  /** [lat, lng] or [lat, lng, severity] */
  points: number[][];
  pct: number;
}

export interface VisCorridorPath {
  /** [lat, lng][] */
  path: number[][];
  totalDist: number;
  nodeCount: number;
  message: string;
  pct: number;
}

export interface VisScoringEdge {
  from: [number, number];
  to: [number, number];
  safety: number;
  light: number;
  crime: number;
}

export interface VisScoring {
  totalEdges: number;
  totalNodes: number;
  sample: VisScoringEdge[];
  message: string;
  pct: number;
}

export interface VisRouteCandidate {
  index: number;
  /** [lat, lng][] */
  path: number[][];
  score: number;
  totalDist: number;
  message: string;
  pct: number;
}

export interface PathfindingVisualizationState {
  /** Whether the SSE stream is active */
  active: boolean;
  /** Progress percentage 0-100 */
  pct: number;
  /** Current phase message */
  message: string;
  /** All bboxes shown so far */
  bboxes: VisBbox[];
  /** All data point layers received */
  dataPoints: Record<string, VisDataPoints>;
  /** The corridor path from Phase 1 */
  corridorPath: number[][] | null;
  /** Edge scoring sample */
  scoring: VisScoring | null;
  /** Route candidates discovered */
  routeCandidates: VisRouteCandidate[];
  /** Whether the stream completed */
  done: boolean;
}

const EMPTY_STATE: PathfindingVisualizationState = {
  active: false,
  pct: 0,
  message: '',
  bboxes: [],
  dataPoints: {},
  corridorPath: null,
  scoring: null,
  routeCandidates: [],
  done: false,
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function usePathfindingVisualization(
  origin: LatLng | null,
  destination: LatLng | null,
  isSearching: boolean,
  searchId: string | null,
  searchClientId: string | null,
  searchSeq: number | null,
) {
  const [state, setState] = useState<PathfindingVisualizationState>(EMPTY_STATE);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const activeRef = useRef(false);
  /** How many characters of XHR responseText we've already parsed */
  const parsedLenRef = useRef(0);
  /** Partial trailing SSE line between onprogress chunks */
  const lineBufferRef = useRef('');
  /** Current SSE event name being assembled */
  const currentEventRef = useRef('');

  const stop = useCallback(() => {
    if (xhrRef.current) {
      try { xhrRef.current.abort(); } catch {}
      xhrRef.current = null;
    }
    activeRef.current = false;
  }, []);

  const reset = useCallback(() => {
    stop();
    setState(EMPTY_STATE);
  }, [stop]);

  useEffect(() => {
    if (!isSearching || !origin || !destination || !searchId || !searchClientId || !Number.isFinite(searchSeq)) {
      if (!isSearching && activeRef.current) {
        stop();
        setState((s) => ({ ...s, active: false }));
      }
      return;
    }

    // Already streaming for this search
    if (activeRef.current) return;
    activeRef.current = true;
    parsedLenRef.current = 0;
    lineBufferRef.current = '';
    currentEventRef.current = '';

    setState({ ...EMPTY_STATE, active: true });

    const url =
      `${BACKEND_BASE}/api/safe-routes/stream?` +
      `origin_lat=${origin.latitude}&origin_lng=${origin.longitude}` +
      `&dest_lat=${destination.latitude}&dest_lng=${destination.longitude}`;

    console.log('[viz] Opening SSE stream:', url);

    let disposed = false;

    (async () => {
      const memoryToken = (globalThis as any).__safenight_access_token;
      const token = memoryToken || (await AsyncStorage.getItem(AUTH_TOKEN_STORAGE_KEY));
      if (disposed || !activeRef.current) return;

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;

      xhr.open('GET', url, true);
      // Ask for SSE format (avoid custom headers that trigger CORS preflight on web)
      xhr.setRequestHeader('Accept', 'text/event-stream');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('X-Search-Id', searchId);
      xhr.setRequestHeader('X-Search-Client', searchClientId);
      xhr.setRequestHeader('X-Search-Seq', String(searchSeq));

    /** Parse any new SSE data that appeared in responseText since last call */
    function parseNewChunks() {
      const text = xhr.responseText;
      if (!text || text.length <= parsedLenRef.current) return;

      const newText = text.slice(parsedLenRef.current);
      parsedLenRef.current = text.length;

      lineBufferRef.current += newText;
      const lines = lineBufferRef.current.split(/\r?\n/);
      lineBufferRef.current = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) {
          if (!line) currentEventRef.current = '';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEventRef.current = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const eventName = currentEventRef.current || 'message';
          try {
            const data = JSON.parse(line.slice(5).trim());
            handleEvent(eventName, data);
          } catch {
            // malformed payload — ignore this event
          }
          currentEventRef.current = '';
        }
      }
    }

      xhr.onprogress = () => {
        parseNewChunks();
      };

      xhr.onload = () => {
        parseNewChunks(); // final flush
        console.log('[viz] SSE stream completed');
        activeRef.current = false;
        xhrRef.current = null;
        setState((s) => ({ ...s, active: false }));
      };

      xhr.onerror = () => {
        console.warn('[viz] SSE stream error');
        activeRef.current = false;
        xhrRef.current = null;
        setState((s) => ({ ...s, active: false }));
      };

      xhr.onabort = () => {
        activeRef.current = false;
        xhrRef.current = null;
      };

      xhr.send();
    })().catch(() => {
      activeRef.current = false;
      xhrRef.current = null;
      setState((s) => ({ ...s, active: false }));
    });

    function handleEvent(event: string, data: any) {
      switch (event) {
        case 'phase':
          setState((s) => ({
            ...s,
            pct: data.pct ?? s.pct,
            message: data.message ?? s.message,
          }));
          break;
        case 'bbox':
          setState((s) => ({
            ...s,
            bboxes: [...s.bboxes, data as VisBbox],
            pct: data.pct ?? s.pct,
            message: data.message ?? s.message,
          }));
          break;
        case 'data_points':
          setState((s) => ({
            ...s,
            dataPoints: { ...s.dataPoints, [data.kind]: data as VisDataPoints },
            pct: data.pct ?? s.pct,
          }));
          break;
        case 'corridor_path':
          setState((s) => ({
            ...s,
            corridorPath: data.path,
            pct: data.pct ?? s.pct,
            message: data.message ?? s.message,
          }));
          break;
        case 'scoring':
          setState((s) => ({
            ...s,
            scoring: data as VisScoring,
            pct: data.pct ?? s.pct,
            message: data.message ?? s.message,
          }));
          break;
        case 'route_candidate':
          setState((s) => ({
            ...s,
            routeCandidates: [...s.routeCandidates, data as VisRouteCandidate],
            pct: data.pct ?? s.pct,
            message: data.message ?? s.message,
          }));
          break;
        case 'done':
          setState((s) => ({ ...s, done: true, pct: 100, message: 'Routes ready!' }));
          break;
        case 'error':
          setState((s) => ({ ...s, message: data.message ?? 'Error', active: false }));
          break;
      }
    }

    return () => {
      disposed = true;
      stop();
    };
  }, [isSearching, origin?.latitude, origin?.longitude, destination?.latitude, destination?.longitude, searchId, searchClientId, searchSeq]);

  return { ...state, reset };
}
