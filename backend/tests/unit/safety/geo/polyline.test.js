const {
  decodePolyline,
  encodePolyline,
} = require('../../../../src/safety/services/geo');

describe('polyline helpers', () => {
  test('decodePolyline decodes a known polyline', () => {
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

    expect(decoded).toHaveLength(3);
  });

  test('encodePolyline encodes known coordinates', () => {
    const encoded = encodePolyline([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);

    expect(encoded).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});
