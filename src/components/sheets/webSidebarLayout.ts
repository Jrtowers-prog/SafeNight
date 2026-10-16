const WEB_SIDEBAR_DOCKED_WIDTH = 56;
const WEB_SIDEBAR_COMPACT_WIDTH = 380;
const WEB_SIDEBAR_EXPANDED_WIDTH = 480;
const WEB_SIDEBAR_MAX_RATIO = 0.5;

export { WEB_SIDEBAR_DOCKED_WIDTH, WEB_SIDEBAR_COMPACT_WIDTH, WEB_SIDEBAR_EXPANDED_WIDTH };

export function getWebSidebarMaxWidth(viewportWidth: number) {
  return Math.max(
    WEB_SIDEBAR_COMPACT_WIDTH,
    Math.floor(viewportWidth * WEB_SIDEBAR_MAX_RATIO),
  );
}

export function getWebSidebarOpenWidth(viewportWidth: number, hasContent: boolean) {
  const maxWidth = getWebSidebarMaxWidth(viewportWidth);
  if (!hasContent) {
    return Math.min(WEB_SIDEBAR_COMPACT_WIDTH, maxWidth);
  }
  return Math.min(WEB_SIDEBAR_EXPANDED_WIDTH, maxWidth);
}

export function getWebSidebarCollapsedWidth(hasContent: boolean) {
  return hasContent ? WEB_SIDEBAR_COMPACT_WIDTH : WEB_SIDEBAR_DOCKED_WIDTH;
}

export function clampWebSidebarWidth(
  width: number,
  viewportWidth: number,
  hasContent: boolean,
) {
  const minWidth = getWebSidebarCollapsedWidth(hasContent);
  const maxWidth = getWebSidebarMaxWidth(viewportWidth);
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

export function resolveWebSidebarSnapTarget(
  width: number,
  velocity: number,
  viewportWidth: number,
  hasContent: boolean,
) {
  const minWidth = getWebSidebarCollapsedWidth(hasContent);
  const maxWidth = getWebSidebarOpenWidth(viewportWidth, hasContent);

  if (velocity > 0.55) {
    return minWidth;
  }

  if (velocity < -0.55) {
    return maxWidth;
  }

  const midpoint = minWidth + (maxWidth - minWidth) / 2;
  return width < midpoint ? minWidth : maxWidth;
}