import { describe, expect, it } from 'vitest';
import fs from 'fs';

describe('AI dispatcher center model', () => {
  it('accepts channel traffic without a manual unit-to-center gate', () => {
    const source = fs.readFileSync('src/services/aiDispatcherRuntimeManager.js', 'utf8');
    expect(source).toContain('dispatcher.matchesChannel(data.channelId)');
    expect(source).not.toContain('unitAccessGuard');
    expect(source).not.toContain('isUnitAllowed(');
  });

  it('does not expose the obsolete manual dispatch-center assignment UI', () => {
    const client = fs.readFileSync('client/src/main.jsx', 'utf8');
    const routes = fs.readFileSync('src/routes/index.js', 'utf8');
    expect(client).not.toContain('/admin/dispatch-centers');
    expect(routes).not.toContain('dispatch-center-assignments');
    expect(fs.existsSync('client/src/pages/DispatchCenterAssignments.jsx')).toBe(false);
    expect(fs.existsSync('src/routes/dispatchCenterAssignmentsRouter.js')).toBe(false);
  });

  it('keeps profiles scoped to a channel and dispatch center only', () => {
    const ui = fs.readFileSync('client/src/pages/AIDispatcherProfiles.jsx', 'utf8');
    expect(ui).toContain('Command Link dispatch center');
    expect(ui).not.toContain('Agency<select');
    expect(ui).not.toContain('agencyId');
  });
});
