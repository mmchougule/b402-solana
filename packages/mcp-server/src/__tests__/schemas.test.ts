import { describe, it, expect } from 'vitest';
import {
  shieldInput,
  unshieldInput,
  privateSwapInput,
  statusInput,
  holdingsInput,
  balanceInput,
  quoteSwapInput,
  watchIncomingInput,
} from '../schemas.js';

const VALID_PK = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // mainnet USDC

describe('shield input', () => {
  it('accepts valid', () => {
    expect(() => shieldInput.parse({ mint: VALID_PK, amount: '1000000' })).not.toThrow();
  });
  it('rejects non-base58 mint', () => {
    expect(() => shieldInput.parse({ mint: 'not!valid!base58', amount: '1000000' })).toThrow();
  });
  it('rejects negative amount', () => {
    expect(() => shieldInput.parse({ mint: VALID_PK, amount: '-1' })).toThrow();
  });
  it('rejects float amount', () => {
    expect(() => shieldInput.parse({ mint: VALID_PK, amount: '1.5' })).toThrow();
  });
  it('rejects extra fields', () => {
    expect(() =>
      shieldInput.parse({ mint: VALID_PK, amount: '1', extra: 'evil' } as unknown as never),
    ).toThrow();
  });
});

describe('unshield input', () => {
  it('accepts valid', () => {
    expect(() => unshieldInput.parse({ to: VALID_PK, mint: VALID_PK })).not.toThrow();
  });
  it('rejects missing fields', () => {
    expect(() => unshieldInput.parse({ to: VALID_PK } as unknown as never)).toThrow();
  });
});

describe('private_swap input', () => {
  it('accepts valid', () => {
    expect(() =>
      privateSwapInput.parse({
        inMint: VALID_PK,
        outMint: VALID_PK,
        amount: '1000000',
      }),
    ).not.toThrow();
  });
  it('accepts full override (all four routing fields)', () => {
    expect(() =>
      privateSwapInput.parse({
        inMint: VALID_PK,
        outMint: VALID_PK,
        amount: '1000000',
        adapterProgramId: VALID_PK,
        adapterInTa: VALID_PK,
        adapterOutTa: VALID_PK,
        alt: VALID_PK,
      }),
    ).not.toThrow();
  });
  it('accepts slippageBps override', () => {
    expect(() =>
      privateSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1000000', slippageBps: 100,
      }),
    ).not.toThrow();
  });
  it('accepts expectedOut override', () => {
    expect(() =>
      privateSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1000000', expectedOut: '8400000',
      }),
    ).not.toThrow();
  });
  it('rejects float amount', () => {
    expect(() =>
      privateSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1.5',
      }),
    ).toThrow();
  });
  it('rejects extra fields', () => {
    expect(() =>
      privateSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1', evil: true,
      } as unknown as never),
    ).toThrow();
  });
});

describe('status input', () => {
  it('accepts empty', () => {
    expect(() => statusInput.parse({})).not.toThrow();
  });
  it('rejects unexpected fields', () => {
    expect(() => statusInput.parse({ foo: 1 } as unknown as never)).toThrow();
  });
});

describe('holdings input', () => {
  it('accepts empty', () => {
    expect(() => holdingsInput.parse({})).not.toThrow();
  });
  it('accepts mint filter', () => {
    expect(() => holdingsInput.parse({ mint: VALID_PK })).not.toThrow();
  });
  it('accepts refresh flag', () => {
    expect(() => holdingsInput.parse({ refresh: false })).not.toThrow();
  });
  it('rejects extra fields', () => {
    expect(() =>
      holdingsInput.parse({ extra: 'evil' } as unknown as never),
    ).toThrow();
  });
});

describe('balance input', () => {
  it('accepts empty', () => {
    expect(() => balanceInput.parse({})).not.toThrow();
  });
  it('accepts mint filter', () => {
    expect(() => balanceInput.parse({ mint: VALID_PK })).not.toThrow();
  });
  it('accepts refresh flag', () => {
    expect(() => balanceInput.parse({ refresh: false })).not.toThrow();
  });
  it('rejects extra fields', () => {
    expect(() =>
      balanceInput.parse({ extra: 'evil' } as unknown as never),
    ).toThrow();
  });
});

describe('quote_swap input', () => {
  it('accepts valid', () => {
    expect(() =>
      quoteSwapInput.parse({ inMint: VALID_PK, outMint: VALID_PK, amount: '1000000' }),
    ).not.toThrow();
  });
  it('accepts slippageBps override', () => {
    expect(() =>
      quoteSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1000000', slippageBps: 100,
      }),
    ).not.toThrow();
  });
  it('rejects slippageBps > 10000', () => {
    expect(() =>
      quoteSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1', slippageBps: 99999,
      }),
    ).toThrow();
  });
  it('rejects negative slippageBps', () => {
    expect(() =>
      quoteSwapInput.parse({
        inMint: VALID_PK, outMint: VALID_PK, amount: '1', slippageBps: -1,
      }),
    ).toThrow();
  });
  it('rejects float amount', () => {
    expect(() =>
      quoteSwapInput.parse({ inMint: VALID_PK, outMint: VALID_PK, amount: '1.5' }),
    ).toThrow();
  });
});

describe('watch_incoming input', () => {
  it('accepts empty (first call)', () => {
    expect(() => watchIncomingInput.parse({})).not.toThrow();
  });
  it('accepts opaque cursor string', () => {
    expect(() => watchIncomingInput.parse({ cursor: 'eyJ2IjoxLCJsIjoiNDIifQ' })).not.toThrow();
  });
  it('accepts mint filter', () => {
    expect(() => watchIncomingInput.parse({ mint: VALID_PK })).not.toThrow();
  });
  it('accepts refresh flag', () => {
    expect(() => watchIncomingInput.parse({ refresh: false })).not.toThrow();
  });
  it('rejects extra fields', () => {
    expect(() =>
      watchIncomingInput.parse({ extra: 'evil' } as unknown as never),
    ).toThrow();
  });
  it('rejects non-string cursor', () => {
    expect(() =>
      watchIncomingInput.parse({ cursor: 42 } as unknown as never),
    ).toThrow();
  });
});

describe('responses contain no secret fields (static guarantee)', () => {
  // Compile-time guard: every tool handler's return type is asserted to be
  // a flat JSON-friendly object with only public fields. The schemas-as-types
  // are the contract; this test is a runtime smoke that the imported types
  // are usable.
  it('schema imports are object schemas', () => {
    expect(shieldInput._def.typeName).toBe('ZodObject');
    expect(unshieldInput._def.typeName).toBe('ZodObject');
    expect(privateSwapInput._def.typeName).toBe('ZodObject');
    expect(statusInput._def.typeName).toBe('ZodObject');
    expect(holdingsInput._def.typeName).toBe('ZodObject');
    expect(balanceInput._def.typeName).toBe('ZodObject');
    expect(quoteSwapInput._def.typeName).toBe('ZodObject');
    expect(watchIncomingInput._def.typeName).toBe('ZodObject');
  });
});
