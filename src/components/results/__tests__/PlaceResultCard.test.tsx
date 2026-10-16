import fs from 'fs';

describe('PlaceResultCard source contract', () => {
  const source = fs.readFileSync(
    require.resolve('../PlaceResultCard.tsx'),
    'utf-8',
  );

  it('renders primary and secondary action hooks through PlaceActionRow', () => {
    expect(source).toMatch(/<PlaceActionRow/);
    expect(source).toMatch(/onSafeDirections=\{onSafeDirections\}/);
    expect(source).toMatch(/onShare=\{onShare\}/);
    expect(source).toMatch(/onSave=\{onSave\}/);
  });

  it('exposes accessible card semantics and selected state', () => {
    expect(source).toMatch(/accessibilityRole="button"/);
    expect(source).toMatch(/accessibilityState=\{\{ selected \}\}/);
    expect(source).toMatch(/const accessibilityLabel = useMemo/);
  });

  it('uses a shared card style path with selected highlight styles', () => {
    expect(source).toMatch(/cardSelected/);
    expect(source).not.toMatch(/cardHovered/);
    expect(source).not.toMatch(/platformVariant/);
  });
});
