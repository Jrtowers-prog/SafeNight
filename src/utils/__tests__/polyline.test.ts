import { decodePolyline, encodePolyline } from '@/src/utils/polyline';

describe('polyline utilities', () => {
  it('encodes and decodes coordinate arrays consistently', () => {
    const coords = [
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ];

    const encoded = encodePolyline(coords);
    const decoded = decodePolyline(encoded);

    expect(decoded).toHaveLength(coords.length);
    decoded.forEach((point, i) => {
      expect(point.latitude).toBeCloseTo(coords[i].latitude, 5);
      expect(point.longitude).toBeCloseTo(coords[i].longitude, 5);
    });
  });

  it('decodes a known google polyline sample', () => {
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

    expect(decoded).toHaveLength(3);
    expect(decoded[0].latitude).toBeCloseTo(38.5, 5);
    expect(decoded[0].longitude).toBeCloseTo(-120.2, 5);
  });
});
