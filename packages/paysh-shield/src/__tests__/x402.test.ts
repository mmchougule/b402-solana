import { describe, it, expect } from 'vitest';
import {
  buildPaymentRequired,
  decodePaymentHeader,
  encodePaymentHeader,
  SOLANA_NETWORKS,
  type PaymentPayload,
  type PaymentRequirement,
} from '../x402.js';

const reqOk = (overrides: Partial<PaymentRequirement> = {}): PaymentRequirement => ({
  scheme: 'exact',
  network: SOLANA_NETWORKS.devnet,
  asset: 'usdc',
  payTo: '4ym542u1DuC2i9hVxnr2EAdss8fHp4Rf4RFnyfqfy82t',
  amount: '1000',
  ...overrides,
});

describe('buildPaymentRequired', () => {
  it('produces a body with x402Version=1 and the supplied accepts', () => {
    const body = buildPaymentRequired([reqOk()]);
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.error).toBe('Payment required');
  });

  it('fills sensible defaults: maxTimeoutSeconds=300, extra={}', () => {
    const body = buildPaymentRequired([reqOk()]);
    expect(body.accepts[0]?.maxTimeoutSeconds).toBe(300);
    expect(body.accepts[0]?.extra).toEqual({});
  });

  it('preserves user-supplied maxTimeoutSeconds + extra', () => {
    const body = buildPaymentRequired([
      reqOk({ maxTimeoutSeconds: 60, extra: { memo: 'hi' } }),
    ]);
    expect(body.accepts[0]?.maxTimeoutSeconds).toBe(60);
    expect(body.accepts[0]?.extra).toEqual({ memo: 'hi' });
  });

  it('rejects an empty accepts array (operator misconfig)', () => {
    expect(() => buildPaymentRequired([])).toThrow(/at least one/);
  });

  it('omits optional fields when not supplied (clean wire shape)', () => {
    const body = buildPaymentRequired([reqOk()]);
    expect('description' in body.accepts[0]!).toBe(false);
    expect('resource' in body.accepts[0]!).toBe(false);
    expect('mimeType' in body.accepts[0]!).toBe(false);
  });
});

describe('decodePaymentHeader', () => {
  const valid: PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: SOLANA_NETWORKS.devnet,
    payload: { transaction: 'AQID' },
  };
  const validHeader = encodePaymentHeader(valid);

  it('round-trips a valid header', () => {
    expect(decodePaymentHeader(validHeader)).toEqual(valid);
  });

  it('rejects empty header', () => {
    expect(() => decodePaymentHeader('')).toThrow(/empty/);
  });

  it('rejects non-JSON body', () => {
    const garbage = Buffer.from('not-json').toString('base64');
    expect(() => decodePaymentHeader(garbage)).toThrow(/JSON/);
  });

  it('rejects wrong x402Version', () => {
    const bad = encodePaymentHeader({ ...valid, x402Version: 2 as 1 });
    expect(() => decodePaymentHeader(bad)).toThrow(/x402Version/);
  });

  it('rejects unsupported scheme', () => {
    const bad = encodePaymentHeader({ ...valid, scheme: 'upto' as 'exact' });
    expect(() => decodePaymentHeader(bad)).toThrow(/scheme/);
  });

  it('rejects missing network', () => {
    const bad = Buffer.from(
      JSON.stringify({ x402Version: 1, scheme: 'exact', payload: { transaction: 'AQID' } }),
    ).toString('base64');
    expect(() => decodePaymentHeader(bad)).toThrow(/network/);
  });

  it('rejects missing transaction in payload', () => {
    const bad = encodePaymentHeader({ ...valid, payload: { transaction: '' } });
    expect(() => decodePaymentHeader(bad)).toThrow(/transaction/);
  });
});

describe('SOLANA_NETWORKS', () => {
  it('mainnet matches the value in pay.sh\'s live catalog', () => {
    expect(SOLANA_NETWORKS.mainnet).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  });
});
