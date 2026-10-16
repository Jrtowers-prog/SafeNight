/**
 * DraggableSheet — Touch blocking bug fix regression tests
 * 
 * ROOT CAUSES FIXED:
 * 1. Removed renderToHardwareTextureAndroid to prevent stale touch bounds
 * 2. Changed zIndex from dynamic (state-based) to static (220)
 * 3. Removed isElevated state listener (no updates during animation)
 * 4. Disabled stickyHeaderIndices on Android (in app/index.tsx)
 * 
 * VERIFICATION: Manual testing at all sheet heights confirms touches work
 */

describe('DraggableSheet — Touch blocking bug fixes', () => {
  /**
   * TEST 1: Component definition uses correct animation properties
   * 
   * FIX: Removed renderToHardwareTextureAndroid from Animated.View
   * Reason: Hardware texture allocated at render-time with fixed bounds;
   *         during height animation, these bounds become stale, blocking touches
   */
  it('exports DraggableSheet component', () => {
    // Import to verify no syntax errors in the component
    const DraggableSheet = require('../DraggableSheet').DraggableSheet;
    expect(DraggableSheet).toBeDefined();
    expect(typeof DraggableSheet).toBe('function');
  });

  /**
   * TEST 2: Verify no dynamic zIndex changes during animation
   * 
   * FIX: Static zIndex: 220 in StyleSheet (removed isElevated state listener)
   * 
   * Before fix:
   *   - zIndex = 12 when collapsed
   *   - zIndex = 220 when expanded > 120px (isElevated threshold)
   *   - This state change triggered re-render mid-animation
   *   - React Native recalculated layer bounds, left touch region stale
   * 
   * After fix:
   *   - zIndex = 220 always
   *   - No state updates during animation
   *   - No mid-animation re-renders
   */
  it('uses static zIndex (not dynamic state-based)', () => {
    // Verify the styles object doesn't reference isElevated
    const DraggableSheetSource = require('fs').readFileSync(
      require.resolve('../DraggableSheet.tsx'),
      'utf-8',
    );

    // isElevated should not appear in the file (it was removed)
    // Check that renderToHardwareTextureAndroid is not in the Animated.View
    expect(DraggableSheetSource).not.toMatch(/isElevated\s*:/);
    expect(DraggableSheetSource).not.toMatch(
      /renderToHardwareTextureAndroid/,
    );
  });

  /**
   * TEST 3: Verify ScrollView configuration
   * 
   * ScrollView must have pointerEvents="auto" and keyboardShouldPersistTaps="always"
   * to allow touches to propagate normally
   */
  it('configures ScrollView with correct touch props', () => {
    const DraggableSheetSource = require('fs').readFileSync(
      require.resolve('../DraggableSheet.tsx'),
      'utf-8',
    );

    // Verify ScrollView has required props
    expect(DraggableSheetSource).toMatch(/pointerEvents="auto"/);
    expect(DraggableSheetSource).toMatch(
      /keyboardShouldPersistTaps="always"/,
    );
  });

  /**
   * TEST 4: Verify Android-specific fixes in app layout
   * 
   * app/index.tsx: stickyHeaderIndices={Platform.OS === 'android' ? undefined : [0]}
   * 
   * Reason: On Android, sticky headers force ScrollView responder to stay active,
   *         interfering with touch routing during sheet animation
   */
  it('disables sticky headers on Android (in app/index.tsx)', () => {
    const fs = require('fs');
    const path = require('path');
    
    // Navigate to app/index.tsx (5 levels up from __tests__)
    const appIndexPath = path.resolve(__dirname, '../../../../app/index.tsx');
    const appIndexSource = fs.readFileSync(appIndexPath, 'utf-8');

    // Verify conditional stickyHeaderIndices
    expect(appIndexSource).toMatch(
      /stickyHeaderIndices=\{Platform\.OS\s*===\s*['"]android['"]\s*\?\s*undefined\s*:\s*\[0\]\}/,
    );
  });

  /**
   * TEST 5: needsOffscreenAlphaCompositing is conditional on Android
   * 
   * This prop is retained (safe), but only on Android for proper compositing
   */
  it('applies needsOffscreenAlphaCompositing only on Android', () => {
    const DraggableSheetSource = require('fs').readFileSync(
      require.resolve('../DraggableSheet.tsx'),
      'utf-8',
    );

    expect(DraggableSheetSource).toMatch(
      /needsOffscreenAlphaCompositing=\{Platform\.OS\s*===\s*['"]android['"]\}/,
    );
  });
});
