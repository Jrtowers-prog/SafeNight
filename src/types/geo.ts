export type LatLng = {
  latitude: number;
  longitude: number;
};

export type PlacePrediction = {
  placeId: string;
  primaryText: string;
  secondaryText?: string;
  fullText: string;
  category?: string;
  placeType?: string;
  address?: {
    houseNumber?: string;
    road?: string;
    neighbourhood?: string;
    city?: string;
    county?: string;
    postcode?: string;
    country?: string;
  };
  location?: LatLng;
  source?: 'osm' | 'os';
};

export type PlaceDetails = {
  placeId: string;
  name: string;
  location: LatLng;
  source?: 'osm' | 'os';
};

export type RouteSegment = {
  startCoord: LatLng;
  endCoord: LatLng;
  midpointCoord: LatLng;
  distanceMeters: number;
  lightingScore: number; // 0-1, where 1 = well lit
  crimeScore: number; // 0-1, where 1 = safe
  activityScore: number; // 0-1, where 1 = active
  combinedScore: number; // 0-1 weighted combination
  color: string; // hex color for rendering
};

export type NavigationStep = {
  instruction: string;      // HTML instruction text (e.g. "Turn left onto Eggbuckland Rd")
  distanceMeters: number;
  durationSeconds: number;
  startLocation: LatLng;
  endLocation: LatLng;
  maneuver?: string;        // e.g. "turn-left", "turn-right", "straight", "uturn-left"
};

export type DirectionsRoute = {
  id: string;
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  path: LatLng[];
  segments?: RouteSegment[];
  steps?: NavigationStep[];
  summary?: string;
};
