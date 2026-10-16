import fs from 'node:fs';
import path from 'node:path';

describe('LimitReachedModal live sharing dismiss copy', () => {
  const sourcePath = path.join(
    process.cwd(),
    'src/components/modals/LimitReachedModal.tsx',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');

  it('uses a softer dismiss label for live location sharing limit reached', () => {
    expect(source).toContain("limitInfo.feature === 'live_sessions'");
    expect(source).toContain("Later, I'll look into live sharing");
  });

  it('keeps default dismiss copy for other upgrade prompts', () => {
    expect(source).toContain(": 'Not Now')");
    expect(source).toContain(": 'Got it';");
  });
});
