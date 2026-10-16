/**
 * useAutoPlaceSearch
 *
 * Replaces the old usePlaceAutocomplete + manual prediction selection.
 * When the user types a query and pauses (600 ms debounce), the hook
 * automatically fetches predictions and selects the first result.
 * Predictions are also exposed so the UI can show a dropdown letting
 * the user pick a different result.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchPlaceDetails, fetchPlacePredictions } from '@/src/services/osmDirections';
import { AppError } from '@/src/types/errors';
import type { LatLng, PlaceDetails, PlacePrediction } from '@/src/types/geo';

export type AutoSearchStatus = 'idle' | 'searching' | 'found' | 'error';

export interface UseAutoPlaceSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  place: PlaceDetails | null;
  predictions: PlacePrediction[];
  status: AutoSearchStatus;
  error: AppError | null;
  lastSuccessfulRadiusMiles: number | null;
  /** Select a specific prediction from the dropdown */
  selectPrediction: (prediction: PlacePrediction) => void;
  /** Clear selected place (e.g. user taps ✕) */
  clear: () => void;
}

export const useAutoPlaceSearch = (
  locationBias?: LatLng | null,
  options?: { subscriptionTier?: string; radiusMiles?: number },
): UseAutoPlaceSearchReturn => {
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState<PlaceDetails | null>(null);
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [status, setStatus] = useState<AutoSearchStatus>('idle');
  const [error, setError] = useState<AppError | null>(null);
  const [lastSuccessfulRadiusMiles, setLastSuccessfulRadiusMiles] = useState<number | null>(null);

  // Track whether the user is actively editing (vs. programmatic set)
  const skipAutoRef = useRef(false);
  // The query text that selectPrediction programmatically set
  const selectedQueryRef = useRef<string | null>(null);

  const setQueryWrapped = useCallback((q: string) => {
    // After selectPrediction, Android can re-fire onChangeText with the same
    // programmatic text.  Swallow that one echo but let genuine edits through.
    if (selectedQueryRef.current !== null) {
      if (q === selectedQueryRef.current) {
        // Same text → Android echo → ignore
        selectedQueryRef.current = null;
        return;
      }
      // Different text → user actually typed → proceed normally
      selectedQueryRef.current = null;
    }
    skipAutoRef.current = false;
    setPlace(null);
    // Clear stale suggestions immediately so UI reflects the current query.
    setPredictions([]);
    setError(null);
    setStatus('idle');
    setLastSuccessfulRadiusMiles(null);
    setQuery(q);
  }, []);

  const selectPrediction = useCallback((prediction: PlacePrediction) => {
    skipAutoRef.current = true;
    selectedQueryRef.current = prediction.primaryText;
    setPredictions([]);
    setQuery(prediction.primaryText);

    if (prediction.location) {
      setPlace({
        placeId: prediction.placeId,
        name: prediction.fullText,
        location: prediction.location,
        source: prediction.source,
      });
      setStatus('found');
    } else {
      // Prediction has no coordinates — fetch details to resolve location
      setStatus('searching');
      fetchPlaceDetails(prediction.placeId)
        .then((details) => {
          setPlace(details);
          setStatus('found');
        })
        .catch(() => {
          setError(new AppError('place_details_error', 'Could not resolve location'));
          setStatus('error');
        });
    }
  }, []);

  const clear = useCallback(() => {
    skipAutoRef.current = true;
    setQuery('');
    setPlace(null);
    setPredictions([]);
    setError(null);
    setStatus('idle');
    setLastSuccessfulRadiusMiles(null);
  }, []);

  type ProgressiveSearchResult = {
    results: PlacePrediction[];
    successfulRadiusMiles: number | null;
  };

  /**
   * Progressive search: try expanding radii if initial search returns no results
   * Sequence: initial → 2x → 5x → 10x → search globally
   */
  const performProgressiveSearch = useCallback(
    async (searchQuery: string, _initialRadiusMiles: number): Promise<ProgressiveSearchResult> => {
      const tier = (options?.subscriptionTier || 'free').toLowerCase();
      
      // Progressive radius stages aligned with the visible distance filter.
      const radiusStages = [1, 2, 3, 5, 10];
      
      for (const radiusMiles of radiusStages) {
        const radiusMeters = Math.round(radiusMiles * 1609.34);
        const results = await fetchPlacePredictions(searchQuery, {
          locationBias: locationBias ?? undefined,
          radiusMeters: locationBias ? radiusMeters : undefined,
          subscriptionTier: tier,
        });
        
        if (results.length > 0) {
          return { results, successfulRadiusMiles: radiusMiles };
        }
      }
      
      // Last attempt: search globally without radius
      const globalResults = await fetchPlacePredictions(searchQuery, {
        subscriptionTier: tier,
      });
      return { results: globalResults, successfulRadiusMiles: null };
    },
    [options?.subscriptionTier, locationBias],
  );

  useEffect(() => {
    if (skipAutoRef.current) return;

    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setStatus('idle');
      setPredictions([]);
      return;
    }

    // If we already resolved this query, skip
    if (place) return;

    setError(null);

    const timer = setTimeout(async () => {
      // Only update status once the user has paused — avoids a state update on every keystroke
      setStatus('searching');
      try {
        const tier = (options?.subscriptionTier || 'free').toLowerCase();
        const radiusMiles = options?.radiusMiles ?? 1;
        
        // Use progressive search if location bias is available
        const searchResult = locationBias
          ? await performProgressiveSearch(trimmed, radiusMiles)
          : {
              results: await fetchPlacePredictions(trimmed, {
                subscriptionTier: tier,
              }),
              successfulRadiusMiles: null,
            };

        if (searchResult.results.length === 0) {
          setStatus('error');
          setPredictions([]);
          setLastSuccessfulRadiusMiles(null);
          setError(new AppError('no_results', 'No places found anywhere'));
          return;
        }

        // Expose all predictions for the dropdown — user must click to select
        setPredictions(searchResult.results);
        setLastSuccessfulRadiusMiles(searchResult.successfulRadiusMiles);
        setStatus('idle');
      } catch (e) {
        setStatus('error');
        setPredictions([]);
        setLastSuccessfulRadiusMiles(null);
        setError(
          e instanceof AppError
            ? e
            : new AppError('autocomplete_error', 'Search failed', e),
        );
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [
    query,
    locationBias,
    locationBias?.latitude,
    locationBias?.longitude,
    place,
    options?.subscriptionTier,
    options?.radiusMiles,
    performProgressiveSearch,
  ]);

  return { query, setQuery: setQueryWrapped, place, predictions, status, error, lastSuccessfulRadiusMiles, selectPrediction, clear };
};
