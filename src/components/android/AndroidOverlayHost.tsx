/**
 * AndroidOverlayHost — Forces UI overlays above Android native map views.
 *
 * On Android, native map views (including WebView SurfaceView)
 * MapView) can sometimes render above sibling React Native views despite
 * elevation/zIndex.  This wrapper creates a separate compositing layer with
 * high elevation and `renderToHardwareTextureAndroid` to guarantee overlays
 * (SearchBar, DraggableSheet, modals, etc.) render above the map.
 *
 * On iOS/web this component is a no-op passthrough (React.Fragment).
 */
import { Platform, StyleSheet, View } from 'react-native';

interface AndroidOverlayHostProps {
  children: React.ReactNode;
}

export function AndroidOverlayHost({ children }: AndroidOverlayHostProps) {
  if (Platform.OS !== 'android') {
    // On non-Android platforms, just render children directly
    return <>{children}</>;
  }

  return (
    <View
      style={styles.host}
      pointerEvents="box-none"
      collapsable={false}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    elevation: 50,
    backgroundColor: 'transparent',
  },
});
