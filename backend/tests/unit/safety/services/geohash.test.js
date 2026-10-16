const { encode, decode, neighbors } = require('../../../../src/safety/services/geohash');

describe('geohash', () => {
  test('encode produces correct length', () => {
    expect(encode(51.0, -0.1, 6)).toHaveLength(6);
    expect(encode(51.0, -0.1, 8)).toHaveLength(8);
  });

  test('encode is deterministic', () => {
    const h1 = encode(51.0, -0.1, 6);
    const h2 = encode(51.0, -0.1, 6);
    expect(h1).toBe(h2);
  });

  test('decode returns valid bbox', () => {
    const hash = encode(51.0, -0.1, 6);
    const bbox = decode(hash);
    expect(bbox.south).toBeLessThan(bbox.north);
    expect(bbox.west).toBeLessThan(bbox.east);
    // Midpoint should be close to original
    expect((bbox.south + bbox.north) / 2).toBeCloseTo(51.0, 1);
    expect((bbox.west + bbox.east) / 2).toBeCloseTo(-0.1, 1);
  });

  test('neighbors returns 8 adjacent cells', () => {
    const hash = encode(51.0, -0.1, 6);
    const n = neighbors(hash);
    expect(Object.keys(n)).toHaveLength(8);
    expect(n.n).not.toBe(hash);
    expect(n.s).not.toBe(hash);
    expect(n.e).not.toBe(hash);
    expect(n.w).not.toBe(hash);
  });

  test('higher precision = smaller bbox', () => {
    const bbox6 = decode(encode(51.0, -0.1, 6));
    const bbox8 = decode(encode(51.0, -0.1, 8));
    const size6 = (bbox6.north - bbox6.south) * (bbox6.east - bbox6.west);
    const size8 = (bbox8.north - bbox8.south) * (bbox8.east - bbox8.west);
    expect(size8).toBeLessThan(size6);
  });
});
