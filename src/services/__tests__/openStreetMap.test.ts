import { AppError } from '@/src/types/errors';

import {
  fetchDirections,
  fetchPlaceDetails,
  fetchPlacePredictions,
  reverseGeocode,
} from '@/src/services/openStreetMap';

const jsonResponse = (body: unknown) => ({
  ok: true,
  headers: {
    get: (name: string) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
  },
  text: async () => JSON.stringify(body),
} as Response);

const xmlResponse = (body: string) => ({
  ok: true,
  headers: {
    get: (name: string) => (String(name).toLowerCase() === 'content-type' ? 'text/xml; charset=utf-8' : null),
  },
  text: async () => body,
} as Response);

describe('openStreetMap service', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns no predictions for blank input', async () => {
    await expect(fetchPlacePredictions('   ')).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps prediction response into place predictions and filters invalid coordinates', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse([
        {
          osm_type: 'node',
          osm_id: 123,
          display_name: 'Oxford Street, London, UK',
          lat: '51.515',
          lon: '-0.141',
        },
        {
          osm_type: 'node',
          osm_id: 999,
          display_name: 'Invalid Place',
          lat: 'not-number',
          lon: '0',
        },
      ]),
    );

    const places = await fetchPlacePredictions('oxford');

    expect(places).toHaveLength(1);
    expect(places[0].placeId).toBe('node:123');
    expect(places[0].primaryText).toBe('Oxford Street');
  });

  it('throws AppError for invalid lookup place id', async () => {
    await expect(fetchPlaceDetails('bad-id')).rejects.toBeInstanceOf(AppError);
  });

  it('maps place lookup result into place details', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse([
        {
          display_name: 'Piccadilly Circus, London, UK',
          lat: '51.5101',
          lon: '-0.1340',
        },
      ]),
    );

    const details = await fetchPlaceDetails('node:42');

    expect(details.placeId).toBe('node:42');
    expect(details.location.latitude).toBeCloseTo(51.5101, 5);
  });

  it('returns null from reverse geocode for non-OK response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false } as Response);

    const result = await reverseGeocode({ latitude: 51.5, longitude: -0.12 });
    expect(result).toBeNull();
  });

  it('returns null from reverse geocode for XML error payloads', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      xmlResponse('<?xml version="1.0" encoding="UTF-8"?><error>rate limit</error>'),
    );

    const result = await reverseGeocode({ latitude: 51.5, longitude: -0.12 });
    expect(result).toBeNull();
  });

  it('throws AppError for XML prediction payloads', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      xmlResponse('<?xml version="1.0" encoding="UTF-8"?><error>bad gateway</error>'),
    );

    await expect(fetchPlacePredictions('oxford')).rejects.toBeInstanceOf(AppError);
  });

  it('throws AppError for empty details payloads', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => '   ',
    } as Response);

    await expect(fetchPlaceDetails('node:42')).rejects.toBeInstanceOf(AppError);
  });

  it('maps reverse geocode response shape to place details', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse({
        status: 'OK',
        result: {
          place_id: 'node:11',
          name: 'Test Place',
          geometry: {
            location: {
              lat: 51.5,
              lng: -0.12,
            },
          },
        },
      }),
    );

    const result = await reverseGeocode({ latitude: 51.5, longitude: -0.12 });
    expect(result?.name).toBe('Test Place');
    expect(result?.source).toBe('osm');
  });

  it('maps OSRM route responses into app routes', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => JSON.stringify({
        code: 'Ok',
        routes: [
          {
            distance: 1000,
            duration: 720,
            geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
          },
        ],
      }),
    } as Response);

    const routes = await fetchDirections(
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 43.252, longitude: -126.453 },
    );

    expect(routes).toHaveLength(1);
    expect(routes[0].path).toHaveLength(3);
    expect(routes[0].durationSeconds).toBe(720);
  });

  it('throws directions error when OSRM response is invalid', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => JSON.stringify({ code: 'NoRoute', message: 'No route found' }),
    } as Response);

    await expect(
      fetchDirections(
        { latitude: 51.5, longitude: -0.12 },
        { latitude: 51.6, longitude: -0.13 },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
