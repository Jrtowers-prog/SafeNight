export interface MapControlLayoutInput {
  viewportHeight: number;
  topInset: number;
  bottomInset: number;
  searchBoundaryBottom: number;
  sheetBoundaryTop: number;
  /** Optional: when true the layout should use split-left/right rendering */
  splitMode?: boolean;
  /** Optional preferred side for action cluster ('left'|'right') */
  preferredActionSide?: 'left' | 'right';
}

interface ResolvedLayoutInput extends MapControlLayoutInput {
  viewportHeight: number;
  topInset: number;
  bottomInset: number;
  searchBoundaryBottom: number;
  sheetBoundaryTop: number;
}

interface MapControlMetrics {
  edgePadding: number;
  minClusterGap: number;
  expandedUtilityControlCount: number;
  collapsedUtilityControlCount: number;
  actionControlCount: number;
  expandedControlSize: number;
  collapsedControlSize: number;
  expandedControlGap: number;
  collapsedControlGap: number;
}

export interface MapControlSafeBounds {
  top: number;
  bottom: number;
  height: number;
}

export interface ClusterPlacement {
  safeBounds: MapControlSafeBounds;
  utility: {
    top: number;
    collapsed: boolean;
    visibleControlCount: number;
    controlSize: number;
    controlGap: number;
    height: number;
  };
  action: {
    top: number;
    visibleControlCount: number;
    controlSize: number;
    controlGap: number;
    height: number;
    /** side indicates horizontal placement intent for the action cluster */
    side: 'left' | 'right';
  };
}

const METRICS: MapControlMetrics = {
  edgePadding: 12,
  minClusterGap: 16,
  expandedUtilityControlCount: 3,
  collapsedUtilityControlCount: 2,
  actionControlCount: 2,
  expandedControlSize: 42,
  collapsedControlSize: 38,
  expandedControlGap: 12,
  collapsedControlGap: 8,
};

function normalize(input: MapControlLayoutInput): ResolvedLayoutInput {
  const viewportHeight = Math.max(0, Number(input.viewportHeight) || 0);
  const topInset = Math.max(0, Number(input.topInset) || 0);
  const bottomInset = Math.max(0, Number(input.bottomInset) || 0);
  const searchBoundaryBottom = Math.max(0, Number(input.searchBoundaryBottom) || 0);
  const safeSheetTopFallback = viewportHeight;
  const rawSheetBoundaryTop = Number(input.sheetBoundaryTop);
  const sheetBoundaryTop = Number.isFinite(rawSheetBoundaryTop)
    ? Math.max(0, rawSheetBoundaryTop)
    : safeSheetTopFallback;

  return {
    viewportHeight,
    topInset,
    bottomInset,
    searchBoundaryBottom,
    sheetBoundaryTop,
  };
}

function clusterHeight(controlCount: number, controlSize: number, controlGap: number): number {
  if (controlCount <= 0) {
    return 0;
  }
  return controlCount * controlSize + (controlCount - 1) * controlGap;
}

export function computeSafeBounds(input: MapControlLayoutInput): MapControlSafeBounds {
  const normalized = normalize(input);
  const topAnchor = Math.max(
    normalized.topInset + METRICS.edgePadding,
    normalized.searchBoundaryBottom + METRICS.edgePadding,
  );
  const bottomAnchor = Math.min(
    normalized.viewportHeight - normalized.bottomInset - METRICS.edgePadding,
    normalized.sheetBoundaryTop - METRICS.edgePadding,
  );
  const clampedBottom = Math.max(topAnchor, bottomAnchor);

  return {
    top: topAnchor,
    bottom: clampedBottom,
    height: Math.max(0, clampedBottom - topAnchor),
  };
}

function getExpandedUtilityHeight(): number {
  return clusterHeight(
    METRICS.expandedUtilityControlCount,
    METRICS.expandedControlSize,
    METRICS.expandedControlGap,
  );
}

function getCollapsedUtilityHeight(): number {
  return clusterHeight(
    METRICS.collapsedUtilityControlCount,
    METRICS.collapsedControlSize,
    METRICS.collapsedControlGap,
  );
}

function getActionHeight(): number {
  return clusterHeight(
    METRICS.actionControlCount,
    METRICS.expandedControlSize,
    METRICS.expandedControlGap,
  );
}

function getAvailableUtilityHeight(bounds: MapControlSafeBounds): number {
  const actionTop = Math.max(bounds.top, bounds.bottom - getActionHeight());
  return Math.max(0, actionTop - bounds.top - METRICS.minClusterGap);
}

function getUtilityLayout(availableUtilityHeight: number): {
  visibleControlCount: number;
  controlSize: number;
  controlGap: number;
  height: number;
} {
  const expanded = {
    visibleControlCount: METRICS.expandedUtilityControlCount,
    controlSize: METRICS.expandedControlSize,
    controlGap: METRICS.expandedControlGap,
    height: getExpandedUtilityHeight(),
  };

  if (availableUtilityHeight >= expanded.height) {
    return expanded;
  }

  const collapsed = {
    visibleControlCount: METRICS.collapsedUtilityControlCount,
    controlSize: METRICS.collapsedControlSize,
    controlGap: METRICS.collapsedControlGap,
    height: getCollapsedUtilityHeight(),
  };

  if (availableUtilityHeight >= collapsed.height) {
    return collapsed;
  }

  const singleControlHeight = clusterHeight(1, METRICS.collapsedControlSize, METRICS.collapsedControlGap);
  if (availableUtilityHeight >= singleControlHeight) {
    return {
      visibleControlCount: 1,
      controlSize: METRICS.collapsedControlSize,
      controlGap: METRICS.collapsedControlGap,
      height: singleControlHeight,
    };
  }

  return {
    visibleControlCount: 0,
    controlSize: METRICS.collapsedControlSize,
    controlGap: METRICS.collapsedControlGap,
    height: 0,
  };
}

export function shouldCollapseUtilityCluster(input: MapControlLayoutInput): boolean {
  const bounds = computeSafeBounds(input);
  const availableUtilityHeight = getAvailableUtilityHeight(bounds);
  return getUtilityLayout(availableUtilityHeight).visibleControlCount < METRICS.expandedUtilityControlCount;
}

export function computeClusterPlacement(input: MapControlLayoutInput): ClusterPlacement {
  const safeBounds = computeSafeBounds(input);
  const actionHeight = getActionHeight();
  const actionTop = Math.max(safeBounds.top, safeBounds.bottom - actionHeight);
  const availableUtilityHeight = Math.max(0, actionTop - safeBounds.top - METRICS.minClusterGap);
  const utilityLayout = getUtilityLayout(availableUtilityHeight);
  const collapsed = utilityLayout.visibleControlCount < METRICS.expandedUtilityControlCount;
  const utilityTop = safeBounds.top;
  // Respect preferredActionSide if provided, otherwise default to 'right'
  const actionSide: 'left' | 'right' = input.preferredActionSide === 'left' ? 'left' : 'right';

  return {
    safeBounds,
    utility: {
      top: utilityTop,
      collapsed,
      visibleControlCount: utilityLayout.visibleControlCount,
      controlSize: utilityLayout.controlSize,
      controlGap: utilityLayout.controlGap,
      height: utilityLayout.height,
    },
    action: {
      top: actionTop,
      visibleControlCount: METRICS.actionControlCount,
      controlSize: METRICS.expandedControlSize,
      controlGap: METRICS.expandedControlGap,
      height: actionHeight,
      side: actionSide,
    },
  };
}
