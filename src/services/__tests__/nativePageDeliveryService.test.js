import { describe, expect, it, vi, beforeEach } from 'vitest';

const { query, ack } = vi.hoisted(() => ({ query: vi.fn(), ack: vi.fn() }));
vi.mock('../../db/index.js', () => ({
  default: { query },
  recordPageAck: ack
}));
const { nativeRadioSocket, nativePageStatus, queueNativePage,
  replayNativePages, recordNativePageReceipt } =
  await import('../nativePageDeliveryService.js');

function authenticated(radioId = '000019') {
  const emitted = [];
  return {
    radioId, isRadioDevice: true, radioTokenPending: false,
    connected: true, assignedUnitId: 22, emitted,
    emit(name, data) { emitted.push({ name, data }); }
  };
}

beforeEach(() => {
  query.mockReset();
  ack.mockReset();
  query.mockImplementation(async sql => ({
    rowCount: 1,
    rows: sql.includes('SELECT * FROM native_page_deliveries')
      ? [{ page_id: 4, radio_id: '000019', message: 'test',
           sender: 'DISPATCH', paging_channel_id: 'OPS__1',
           expires_at: new Date(Date.now() + 120000) }]
      : []
  }));
});

describe('native radio paging authorization and custody', () => {
  it('requires a token-authenticated physical radio with an exact radio ID', () => {
    expect(nativeRadioSocket(authenticated('000019'), '000019')).toBe(true);
    expect(nativeRadioSocket(authenticated('000019'), '000020')).toBe(false);
    expect(nativeRadioSocket({ ...authenticated(), radioTokenPending: true }, '000019')).toBe(false);
    expect(nativeRadioSocket({ ...authenticated(), isRadioDevice: false }, '000019')).toBe(false);
    expect(nativeRadioSocket({ ...authenticated(), connected: false }, '000019')).toBe(false);
  });

  it('queues and delivers to the actual selected radio, not another radio on the same unit', async () => {
    const target = authenticated('000019');
    const foreign = authenticated('000020');
    const signaling = { io: { sockets: { sockets: new Map([['a', target], ['b', foreign]]) } } };
    await queueNativePage(signaling, { id: 4, message: 'test', sender: 'DISPATCH' },
      [{ radioId: '000019', fcmTokens: [], apnsTokens: [] }], 'OPS__1');
    expect(target.emitted.some(x => x.name === 'radio:page')).toBe(true);
    expect(foreign.emitted).toHaveLength(0);
  });

  it('replays only unexpired pending messages on reconnect', async () => {
    const target = authenticated();
    const sent = await replayNativePages(target);
    expect(sent).toBe(1);
    expect(target.emitted[0].data.pageId).toBe('4');
  });

  it('rejects forged and expired receipts; records only owned acknowledged pages', async () => {
    const caller = authenticated();
    expect(await recordNativePageReceipt({ ...caller, isRadioDevice: false },
      { pageId: '4', kind: 'acknowledged' })).toBe(false);
    expect(await recordNativePageReceipt(caller, { pageId: 'not-an-id', kind: 'delivered' }))
      .toBe(false);
    expect(ack).not.toHaveBeenCalled();
    expect(await recordNativePageReceipt(caller, { pageId: '4', kind: 'acknowledged' }))
      .toBe(true);
    expect(ack).toHaveBeenCalledWith(4, 22, '000019');
    expect(query.mock.calls.some(c => c[0].includes('expires_at > NOW()'))).toBe(true);
  });

  it('distinguishes created, delivered, operator-acknowledged and expired', () => {
    const base = { expires_at: new Date(Date.now() + 10000) };
    expect(nativePageStatus(base)).toBe('queued');
    expect(nativePageStatus({ ...base, sent_at: new Date() })).toBe('pending');
    expect(nativePageStatus({ ...base, delivered_at: new Date() })).toBe('delivered');
    expect(nativePageStatus({ ...base, acknowledged_at: new Date() })).toBe('acknowledged');
    expect(nativePageStatus({ expires_at: new Date(Date.now() - 10000) })).toBe('expired');
  });
});
