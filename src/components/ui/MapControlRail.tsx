import { memo, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  computeClusterPlacement,
  type MapControlLayoutInput,
} from '@/src/components/ui/mapControlLayout';

type ControlNodeRenderer = ReactNode | ((input: { compressed: boolean }) => ReactNode);

const PRIORITY_KEYS = ['profile', 'safety', 'live', 'report', 'currentLocation'] as const;

export interface MapControlRailProps {
  layoutInput: MapControlLayoutInput;
  profileControl: ControlNodeRenderer;
  safetyCircleControl: ControlNodeRenderer;
  liveLocationControl?: ControlNodeRenderer;
  reportControl: ControlNodeRenderer;
  currentLocationControl: ControlNodeRenderer;
  showLiveLocationWhenCompressed?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function resolveControlNode(
  control: ControlNodeRenderer | undefined,
  compressed: boolean,
): ReactNode {
  if (!control) {
    return null;
  }

  if (typeof control === 'function') {
    return control({ compressed });
  }

  return control;
}

function renderControlStack(
  controls: ReactNode[],
  gap: number,
  compressed: boolean,
): ReactNode[] {
  return controls
    .filter((control) => control != null)
    .map((control, index) => (
      <View
        key={`control-${index}`}
        style={[
          styles.controlItem,
          index > 0 ? { marginTop: gap } : null,
          compressed ? styles.controlItemCompressed : null,
        ]}
      >
        {control}
      </View>
    ));
}

function MapControlRailComponent({
  layoutInput,
  profileControl,
  safetyCircleControl,
  liveLocationControl,
  reportControl,
  currentLocationControl,
  showLiveLocationWhenCompressed = false,
  style,
  testID,
}: MapControlRailProps) {
  const placement = useMemo(() => computeClusterPlacement(layoutInput), [layoutInput]);
  const compressed = placement.utility.collapsed;

  // Clamp top positions into safe bounds so clusters never float too high/low
  const clamp = (desiredTop: number, clusterHeight: number) => {
    const minTop = placement.safeBounds.top;
    const maxTop = Math.max(placement.safeBounds.top, placement.safeBounds.bottom - clusterHeight);
    return Math.min(Math.max(desiredTop, minTop), maxTop);
  };

  const utilityControls = useMemo(() => {
    const controls: ReactNode[] = [
      resolveControlNode(profileControl, compressed),
      resolveControlNode(safetyCircleControl, compressed),
    ];

    if (!compressed || showLiveLocationWhenCompressed) {
      controls.push(resolveControlNode(liveLocationControl, compressed));
    }

    return controls.slice(0, placement.utility.visibleControlCount);
  }, [
    compressed,
    placement.utility.visibleControlCount,
    profileControl,
    safetyCircleControl,
    liveLocationControl,
    showLiveLocationWhenCompressed,
  ]);

  const actionControls = useMemo(
    () => [resolveControlNode(reportControl, compressed), resolveControlNode(currentLocationControl, compressed)],
    [reportControl, currentLocationControl, compressed],
  );

  const webDockControls = useMemo(
    () => [...utilityControls, ...actionControls].filter((control): control is ReactNode => control != null),
    [actionControls, utilityControls],
  );

  // When splitMode is enabled, split controls left/right using the priority mapping.
  const splitLeftControls = useMemo(() => {
    if (!layoutInput.splitMode) return null;
    // left: first two priorities
    const left: ReactNode[] = [];
    // map priorities to actual renderers
    const byKey: Record<string, ReactNode | undefined> = {
      profile: resolveControlNode(profileControl, compressed),
      safety: resolveControlNode(safetyCircleControl, compressed),
      live: resolveControlNode(liveLocationControl, compressed),
      report: resolveControlNode(reportControl, compressed),
      currentLocation: resolveControlNode(currentLocationControl, compressed),
    };
    const leftKeys = PRIORITY_KEYS.slice(0, 2);
    for (const k of leftKeys) {
      const c = byKey[k];
      if (c != null) left.push(c);
    }
    return left;
  }, [layoutInput.splitMode, profileControl, safetyCircleControl, liveLocationControl, reportControl, currentLocationControl, compressed]);

  const splitRightControls = useMemo(() => {
    if (!layoutInput.splitMode) return null;
    const byKey: Record<string, ReactNode | undefined> = {
      profile: resolveControlNode(profileControl, compressed),
      safety: resolveControlNode(safetyCircleControl, compressed),
      live: resolveControlNode(liveLocationControl, compressed),
      report: resolveControlNode(reportControl, compressed),
      currentLocation: resolveControlNode(currentLocationControl, compressed),
    };
    // right: remaining priorities (3)
    const rightKeys = PRIORITY_KEYS.slice(2);
    const right: ReactNode[] = [];
    for (const k of rightKeys) {
      const c = byKey[k];
      if (c != null) right.push(c);
    }
    return right;
  }, [layoutInput.splitMode, profileControl, safetyCircleControl, liveLocationControl, reportControl, currentLocationControl, compressed]);

  // Compute clamped tops
  const utilityTopClamped = clamp(placement.utility.top, placement.utility.height);
  const actionTopClamped = clamp(placement.action.top, placement.action.height);

  const actionSide = placement.action.side || 'right';
  const webDockHeight = webDockControls.length > 0
    ? webDockControls.length * 44 + Math.max(0, webDockControls.length - 1) * 12
    : 0;
  const webDockTop = clamp(
    placement.safeBounds.top + (placement.safeBounds.height - webDockHeight) / 2,
    webDockHeight,
  );

  const rootStyle = [
    styles.root,
    Platform.OS === 'web' ? { zIndex: 1500 } : {},
    actionSide === 'right' ? styles.rootRight : styles.rootLeft,
    style,
  ];

  // Render split layout when requested
  if (layoutInput.splitMode) {
    return (
      <View pointerEvents="box-none" style={rootStyle} testID={testID}>
        {/* left cluster (two priority items) */}
        <View
          pointerEvents="box-none"
          style={[
            styles.cluster,
            styles.utilityCluster,
            styles.leftCluster,
            { top: utilityTopClamped },
            compressed ? styles.clusterCompressed : null,
          ]}
        >
          {renderControlStack(splitLeftControls || [], placement.utility.controlGap, compressed)}
        </View>

        {/* right cluster (remaining) */}
        <View
          pointerEvents="box-none"
          style={[
            styles.cluster,
            styles.actionCluster,
            styles.rightCluster,
            { top: actionTopClamped },
          ]}
        >
          {renderControlStack(splitRightControls || [], placement.action.controlGap, false)}
        </View>
      </View>
    );
  }

  if (Platform.OS === 'web') {
    return (
      <View pointerEvents="box-none" style={rootStyle} testID={testID}>
        <View
          pointerEvents="box-none"
          style={[
            styles.cluster,
            styles.webDock,
            { top: webDockTop },
          ]}
        >
          {renderControlStack(webDockControls, 12, false)}
        </View>
      </View>
    );
  }

  return (
    <View pointerEvents="box-none" style={rootStyle} testID={testID}>
      <View
        pointerEvents="box-none"
        style={[
          styles.cluster,
          styles.utilityCluster,
          {
            top: utilityTopClamped,
          },
          compressed ? styles.clusterCompressed : null,
        ]}
      >
        {renderControlStack(utilityControls, placement.utility.controlGap, compressed)}
      </View>

      <View
        pointerEvents="box-none"
        style={[
          styles.cluster,
          styles.actionCluster,
          actionSide === 'right' ? styles.rightCluster : styles.leftCluster,
          {
            top: actionTopClamped,
          },
        ]}
      >
        {renderControlStack(actionControls, placement.action.controlGap, false)}
      </View>
    </View>
  );
}

export const MapControlRail = memo(MapControlRailComponent);

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 12,
    width: 56,
    zIndex: 100,
    alignItems: 'flex-end',
  },
  rootLeft: {
    left: 12,
    right: undefined,
    alignItems: 'flex-start',
  },
  rootRight: {
    right: 12,
    left: undefined,
    alignItems: 'flex-end',
  },
  cluster: {
    position: 'absolute',
    right: 0,
    alignItems: 'center',
  },
  leftCluster: {
    left: 0,
    right: undefined,
    alignItems: 'center',
  },
  rightCluster: {
    right: 0,
    left: undefined,
    alignItems: 'center',
  },
  utilityCluster: {
    zIndex: 110,
  },
  actionCluster: {
    zIndex: 100,
  },
  webDock: {
    right: 0,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.95)',
    boxShadow: '0 10px 24px rgba(15, 23, 42, 0.14)',
  } as any,
  clusterCompressed: {
    transform: [{ scale: 0.96 }],
  },
  controlItem: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlItemCompressed: {
    opacity: 0.98,
  },
});
