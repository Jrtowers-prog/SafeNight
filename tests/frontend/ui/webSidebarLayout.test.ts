import {
  clampWebSidebarWidth,
  getWebSidebarCollapsedWidth,
  getWebSidebarMaxWidth,
  getWebSidebarOpenWidth,
  resolveWebSidebarSnapTarget,
} from '@/src/components/sheets/webSidebarLayout';

describe('webSidebarLayout', () => {
  it('keeps the width inside the content bounds', () => {
    expect(clampWebSidebarWidth(100, 1200, true)).toBe(380);
    expect(clampWebSidebarWidth(600, 1200, true)).toBe(600);
    expect(clampWebSidebarWidth(900, 1200, true)).toBe(getWebSidebarMaxWidth(1200));
  });

  it('uses a smaller docked width when content is absent', () => {
    expect(getWebSidebarCollapsedWidth(false)).toBe(56);
    expect(getWebSidebarOpenWidth(1200, false)).toBe(380);
  });

  it('snaps toward the expected open or collapsed target', () => {
    expect(resolveWebSidebarSnapTarget(340, 0, 1200, true)).toBe(380);
    expect(resolveWebSidebarSnapTarget(430, 0, 1200, true)).toBe(480);
    expect(resolveWebSidebarSnapTarget(100, 0.8, 1200, true)).toBe(380);
    expect(resolveWebSidebarSnapTarget(100, 0, 1200, false)).toBe(56);
  });
});