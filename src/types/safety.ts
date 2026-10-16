import type { LatLng } from '@/src/types/geo';

export type CrimeIncident = {
  category: string;
  month: string;
  location: LatLng;
};

export type PoliceCrimeApiItem = {
  category?: string;
  month?: string;
  location?: {
    latitude?: string;
    longitude?: string;
  };
};

export type OverpassApiResponse = {
  elements?: Array<{
    type?: string;
    id?: number;
    tags?: Record<string, string>;
  }>;
};

export type RoadSegment = {
  id: number;
  roadType: string;
  lit: 'yes' | 'no' | 'unknown';
  isWellLit: boolean;
  name?: string;
};

export type OverpassHighwayStats = {
  totalHighways: number;
  unlitCount: number;
  wellLitCount: number;
  unknownLitCount: number;
  byHighway: Record<string, number>;
  roadSegments: RoadSegment[];
};

export type SegmentScore = {
  segmentId: number;
  lightingScore: number; // 0-1
  crimeScore: number; // 0-1 (0 = dangerous, 1 = safe)
  combinedScore: number; // 0-1
  color: string; // Hex color code
  riskLevel: 'safe' | 'caution' | 'danger';
};

export type SafetySummary = {
  crimeCount: number;
  crimes: CrimeIncident[];
  highwayStats: OverpassHighwayStats;
  openPlacesCount: number;
  segmentScores?: SegmentScore[];
  overallScore?: number; // Average of all segments
};
