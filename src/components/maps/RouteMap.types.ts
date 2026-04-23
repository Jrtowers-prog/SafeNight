import type { RoadLabel, RouteSegment, SafetyMarker } from '@/src/services/safetyMapData';
import type { DirectionsRoute, LatLng } from '@/src/types/geo';

export type MapType = 'roadmap';

/** A live friend's position to display on the map */
export interface FriendMapMarker {
  userId: string;
  name: string;
  lat: number;
  lng: number;
  destinationName?: string;
  /** Breadcrumb trail — actual positions taken so far */
  path?: Array<{ lat: number; lng: number }>;
  /** Full planned route polyline (shared at session start) */
  routePath?: Array<{ lat: number; lng: number }>;
}

export type RouteMapProps = {
  origin: LatLng | null;
  destination: LatLng | null;
  routes: DirectionsRoute[];
  selectedRouteId: string | null;
  /** Toggle for optional map detail overlays (currently road-name labels). */
  showExtraDetail?: boolean;
  safetyMarkers?: SafetyMarker[];
  routeSegments?: RouteSegment[];
  roadLabels?: RoadLabel[];
  /** When set, the map smoothly pans to this location. Bump the key to re-trigger. */
  panTo?: { location: LatLng; key: number } | null;
  /** Increment to force fitting visible search-candidate markers into view. */
  fitCandidateBoundsToken?: number;
  /** Android-only extra fit trigger for search distance/category changes. */
  androidFitCandidateBoundsToken?: number;
  /** Android-only zoom ceiling used when explicit candidate refits happen. */
  androidCandidateRefitMaxZoom?: number;
  /** Extra top padding (px) used when fitting bounds so points stay below top search UI. */
  fitTopPadding?: number;
  /** Extra bottom padding (px) used when fitting bounds so points are not hidden behind sheets. */
  fitBottomPadding?: number;
  /** Extra left/right padding (px) used when fitting bounds so points are not clipped by UI rails. */
  fitSidePadding?: number;
  /** Extra top padding used only when candidate search/filter autofocus triggers a refit. */
  candidateFitTopPadding?: number;
  /** Extra bottom padding used only when candidate search/filter autofocus triggers a refit. */
  candidateFitBottomPadding?: number;
  /** Extra side padding used only when candidate search/filter autofocus triggers a refit. */
  candidateFitSidePadding?: number;
  /** Show map zoom controls (+ / -). Useful to disable on phone-web layouts. */
  showZoomControls?: boolean;
  /** Navigation mode — when true, the map follows the user and tilts */
  isNavigating?: boolean;
  /** Live user location during navigation */
  navigationLocation?: LatLng | null;
  /** User heading in degrees (0 = north) */
  navigationHeading?: number | null;
  /** Map display type (roadmap, satellite, hybrid, terrain) */
  mapType?: MapType;
  /** When set, only markers of this kind are shown and they're rendered larger */
  highlightCategory?: string | null;
  /** Max navigation distance in km — draws a red boundary circle around origin */
  maxDistanceKm?: number | null;
  /** Live friend positions to show on the map */
  friendMarkers?: FriendMapMarker[];
  /** When true, uses a lower camera zoom so the user sees more map context in PiP */
  isInPipMode?: boolean;
  /** Increment to force map to resume navigation-follow (recenter) mode */
  recenterSignal?: number;
  /** Increment to trigger out-of-range visual cue (zoom out + red circle blink). */
  outOfRangeCueSignal?: number;
  onSelectRoute?: (routeId: string) => void;
  onSelectMarker?: (markerId: string) => void;
  onFindSafeRoutes?: (markerId: string) => void;
  onDismissMarkerDetails?: (markerId?: string) => void;
  onLongPress?: (location: LatLng) => void;
  onMapPress?: (location: LatLng) => void;
  onNavigationFollowChange?: (isFollowing: boolean) => void;
  onUserInteraction?: () => void;
  /** Called when user finishes dragging/panning the map with the new center location */
  onMapCenterChanged?: (location: LatLng) => void;
  /** SSE URL for real-time pathfinding visualisation — when set, the WebView
   *  opens an EventSource to this URL and renders progress on the map. */
  vizStreamUrl?: string | null;
  /** Real backend progress percentage (0-100) for visualisation progress bar. */
  vizProgressPct?: number | null;
  /** Real backend progress message (shown in bottom-sheet loader, not on map). */
  vizProgressMessage?: string | null;
};
