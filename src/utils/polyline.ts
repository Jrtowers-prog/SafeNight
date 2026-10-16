import type { LatLng } from '@/src/types/geo';

export const decodePolyline = (encoded: string): LatLng[] => {
  let index = 0;
  const length = encoded.length;
  let latitude = 0;
  let longitude = 0;
  const coordinates: LatLng[] = [];

  while (index < length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    latitude += deltaLat;

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    longitude += deltaLng;

    coordinates.push({
      latitude: latitude / 1e5,
      longitude: longitude / 1e5,
    });
  }

  return coordinates;
};

export const encodePolyline = (coordinates: LatLng[]): string => {
  let lastLatitude = 0;
  let lastLongitude = 0;
  let result = '';

  coordinates.forEach((point) => {
    const latitude = Math.round(point.latitude * 1e5);
    const longitude = Math.round(point.longitude * 1e5);

    const deltaLat = latitude - lastLatitude;
    const deltaLng = longitude - lastLongitude;

    result += encodeSignedNumber(deltaLat) + encodeSignedNumber(deltaLng);

    lastLatitude = latitude;
    lastLongitude = longitude;
  });

  return result;
};

const encodeSignedNumber = (value: number): string => {
  let shifted = value << 1;

  if (value < 0) {
    shifted = ~shifted;
  }

  return encodeUnsignedNumber(shifted);
};

const encodeUnsignedNumber = (value: number): string => {
  let result = '';
  let remaining = value;

  while (remaining >= 0x20) {
    const nextValue = (0x20 | (remaining & 0x1f)) + 63;
    result += String.fromCharCode(nextValue);
    remaining >>= 5;
  }

  result += String.fromCharCode(remaining + 63);
  return result;
};
