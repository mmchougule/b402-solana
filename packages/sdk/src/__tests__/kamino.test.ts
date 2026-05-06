/**
 * Unit tests for the kamino helper module.
 *
 * These guard the byte-level Borsh layout of `KaminoAction` payloads and
 * the positional ordering of `ra_deposit_per_user` / `ra_withdraw_per_user`
 * remaining_accounts. The Rust adapter's positional indexes
 * (`programs/b402-kamino-adapter/src/lib.rs::ra_*`) are the source of
 * truth — these tests fail loudly if the JS helpers drift.
 */
import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildKaminoDepositActionPayload,
  buildKaminoWithdrawActionPayload,
  buildKaminoExecuteIxData,
  buildKaminoDepositRemainingAccounts,
  buildKaminoWithdrawRemainingAccounts,
  type KaminoReserveAccounts,
  type KaminoPerUserAccounts,
} from '../kamino.js';

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

function fixtureReserve(opts: { farmAttached?: boolean } = {}): KaminoReserveAccounts {
  return {
    reserve: new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'),
    lendingMarket: new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'),
    lendingMarketAuthority: new PublicKey('9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo'),
    reserveLiquiditySupply: new PublicKey('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'),
    reserveCollateralMint: new PublicKey('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D'),
    reserveCollateralReserveDestSupply: new PublicKey('3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL'),
    reserveLiquidityMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    oracles: {
      pyth: new PublicKey('Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'),
      switchboardPrice: null,
      switchboardTwap: null,
      scope: new PublicKey('3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C'),
    },
    reserveFarmCollateral: opts.farmAttached
      ? new PublicKey('JBoEyjNDpbR4hpvN4VUwYwgjeQrUdrfTu5dvYuofZGhi')
      : PublicKey.default,
    farmsProgram: new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr'),
    klendProgram: new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'),
  };
}

function fixturePerUser(): KaminoPerUserAccounts {
  return {
    userMetadata: new PublicKey('FwYRdpV1J1nwKcuw2VcmCgFJfUqxK2ohMjEkkuyMa42n'),
    obligation: new PublicKey('39PZ1HPWZ1pAoGYUhPDBRYXbGxzNVoauDhHasyJy1Wxk'),
    ownerUsdcAta: new PublicKey('ADGD9S1HkPc8VxPqUvubD1xbE6kuxs9pZE3Z2gxUNRiU'),
    obligationFarm: new PublicKey('CFinwCcN5z3hKwoaiqFEvjsQRTzcJTYAzQXHzSCvm6Hv'),
    ownerPda: new PublicKey('9tbxTfaB8jShgFwtHtK6iTvjRQLCRRG61TEyWY9yyJV1'),
  };
}

describe('buildKaminoDepositActionPayload', () => {
  it('encodes Deposit variant tag + reserve pubkey + 2 u64 LE fields', () => {
    const r = fixtureReserve();
    const payload = buildKaminoDepositActionPayload({
      reserve: r.reserve, inAmount: 1_000_000n, minKtOut: 0n,
    });
    expect(payload.length).toBe(1 + 32 + 8 + 8);
    expect(payload[0]).toBe(0); // Deposit variant
    expect(Buffer.from(payload.slice(1, 33))).toEqual(r.reserve.toBuffer());
    const inLe = Buffer.from(payload.slice(33, 41));
    const minLe = Buffer.from(payload.slice(41, 49));
    expect(inLe.readBigUInt64LE(0)).toBe(1_000_000n);
    expect(minLe.readBigUInt64LE(0)).toBe(0n);
  });

  it('round-trips a non-zero minKtOut', () => {
    const r = fixtureReserve();
    const payload = buildKaminoDepositActionPayload({
      reserve: r.reserve, inAmount: 5_000_000n, minKtOut: 4_900_000n,
    });
    const minLe = Buffer.from(payload.slice(41, 49));
    expect(minLe.readBigUInt64LE(0)).toBe(4_900_000n);
  });
});

describe('buildKaminoWithdrawActionPayload', () => {
  it('encodes Withdraw variant tag (1) + reserve + ktIn + minUnderlying', () => {
    const r = fixtureReserve();
    const payload = buildKaminoWithdrawActionPayload({
      reserve: r.reserve, ktIn: 999_999n, minUnderlyingOut: 990_000n,
    });
    expect(payload.length).toBe(1 + 32 + 8 + 8);
    expect(payload[0]).toBe(1); // Withdraw variant — MUST differ from Deposit (0)
    expect(Buffer.from(payload.slice(1, 33))).toEqual(r.reserve.toBuffer());
    const ktInLe = Buffer.from(payload.slice(33, 41));
    const minOutLe = Buffer.from(payload.slice(41, 49));
    expect(ktInLe.readBigUInt64LE(0)).toBe(999_999n);
    expect(minOutLe.readBigUInt64LE(0)).toBe(990_000n);
  });

  it('discriminates Deposit vs Withdraw at byte 0', () => {
    const r = fixtureReserve();
    const dep = buildKaminoDepositActionPayload({ reserve: r.reserve, inAmount: 1n, minKtOut: 0n });
    const wd = buildKaminoWithdrawActionPayload({ reserve: r.reserve, ktIn: 1n, minUnderlyingOut: 0n });
    expect(dep[0]).not.toBe(wd[0]);
  });
});

describe('buildKaminoExecuteIxData', () => {
  it('layout: disc[8] | in_amount[8] | expected_out[8] | len[4] | payload', () => {
    const action = Buffer.from([99, 0xaa, 0xbb]); // arbitrary
    const ix = buildKaminoExecuteIxData({
      inAmount: 1_000_000n,
      expectedOut: 0n,
      actionPayload: action,
    });
    expect(ix.length).toBe(8 + 8 + 8 + 4 + action.length);
    // disc — sha256("global:execute")[..8]
    expect(Array.from(ix.slice(0, 8))).toEqual([130, 221, 242, 154, 13, 193, 189, 29]);
    // in_amount LE
    expect(Buffer.from(ix.slice(8, 16)).readBigUInt64LE(0)).toBe(1_000_000n);
    // expected_out LE
    expect(Buffer.from(ix.slice(16, 24)).readBigUInt64LE(0)).toBe(0n);
    // vec length u32 LE
    expect(Buffer.from(ix.slice(24, 28)).readUInt32LE(0)).toBe(action.length);
    // payload bytes
    expect(Array.from(ix.slice(28))).toEqual(Array.from(action));
  });
});

describe('buildKaminoDepositRemainingAccounts (ra_deposit_per_user)', () => {
  it('has exactly 21 entries — MIN_LEN=21 in the adapter (slot 20 = OWNER_USDC_ATA)', () => {
    const accts = buildKaminoDepositRemainingAccounts(fixtureReserve(), fixturePerUser());
    expect(accts.length).toBe(21);
  });

  it('positional order matches programs/b402-kamino-adapter::ra_deposit_per_user', () => {
    // Index map (source of truth: ra_deposit_per_user comments in lib.rs)
    //   0  reserve              (writable)
    //   1  lending_market
    //   2  lending_market_authority
    //   3  reserve_liquidity_supply (writable)
    //   4  reserve_collateral_mint   (writable)
    //   5  reserve_coll_dest_supply  (writable)
    //   6  pyth (or sentinel)
    //   7  switchboard_price (or sentinel)
    //   8  switchboard_twap (or sentinel)
    //   9  scope (or sentinel)
    //   10 reserve_liquidity_mint
    //   11 farms_program
    //   12 user_metadata (writable)
    //   13 obligation (writable)
    //   14 obligation_farm (writable iff farm)
    //   15 reserve_farm_state (writable iff farm)
    //   16 instructions_sysvar
    //   17 system_program
    //   18 sysvar_rent
    //   19 owner_pda
    const r = fixtureReserve({ farmAttached: true });
    const u = fixturePerUser();
    const a = buildKaminoDepositRemainingAccounts(r, u);
    expect(a[0].pubkey).toEqual(r.reserve);
    expect(a[1].pubkey).toEqual(r.lendingMarket);
    expect(a[2].pubkey).toEqual(r.lendingMarketAuthority);
    expect(a[3].pubkey).toEqual(r.reserveLiquiditySupply);
    expect(a[4].pubkey).toEqual(r.reserveCollateralMint);
    expect(a[5].pubkey).toEqual(r.reserveCollateralReserveDestSupply);
    expect(a[6].pubkey).toEqual(r.oracles.pyth);
    expect(a[10].pubkey).toEqual(r.reserveLiquidityMint);
    expect(a[11].pubkey).toEqual(r.farmsProgram);
    expect(a[12].pubkey).toEqual(u.userMetadata);
    expect(a[13].pubkey).toEqual(u.obligation);
    expect(a[14].pubkey).toEqual(u.obligationFarm);
    expect(a[15].pubkey).toEqual(r.reserveFarmCollateral);
    expect(a[16].pubkey).toEqual(SYSVAR_INSTRUCTIONS);
    expect(a[17].pubkey).toEqual(SystemProgram.programId);
    expect(a[18].pubkey).toEqual(SYSVAR_RENT);
    expect(a[19].pubkey).toEqual(u.ownerPda);
    expect(a[20].pubkey).toEqual(u.ownerUsdcAta); // slot 20 — OWNER_USDC_ATA, the per-user source liquidity
  });

  it('writable flags match adapter expectations', () => {
    const r = fixtureReserve({ farmAttached: true });
    const a = buildKaminoDepositRemainingAccounts(r, fixturePerUser());
    expect(a[0].isWritable).toBe(true);  // reserve
    expect(a[1].isWritable).toBe(false); // market
    expect(a[3].isWritable).toBe(true);  // liq supply
    expect(a[4].isWritable).toBe(true);  // coll mint
    expect(a[5].isWritable).toBe(true);  // coll dest supply
    expect(a[12].isWritable).toBe(true); // user_metadata (lazy init)
    expect(a[13].isWritable).toBe(true); // obligation (lazy init)
    expect(a[14].isWritable).toBe(true); // obligation_farm — farm IS attached
    expect(a[15].isWritable).toBe(true); // reserve_farm_state — farm IS attached
    // owner_pda must be WRITABLE — kamino-adapter signs via PDA seeds for
    // Kamino's init_user_metadata + init_obligation, which require the
    // obligation owner as signer-writable. Caught on mainnet 2026-05-05
    // as PrivilegeEscalation when this was readonly.
    expect(a[19].isWritable).toBe(true);
    // owner_usdc_ata must be WRITABLE — adapter SPL-transfers FROM
    // adapter_in_ta INTO this ATA pre-CPI. Kamino then debits it.
    expect(a[20].isWritable).toBe(true);
  });

  it('no-farm reserve uses klend sentinel + readonly farm slots', () => {
    const r = fixtureReserve({ farmAttached: false });
    const a = buildKaminoDepositRemainingAccounts(r, fixturePerUser());
    expect(a[14].pubkey).toEqual(r.klendProgram);
    expect(a[14].isWritable).toBe(false);
    expect(a[15].pubkey).toEqual(r.klendProgram);
    expect(a[15].isWritable).toBe(false);
  });

  it('falls back to klend sentinel for missing oracles', () => {
    const r = fixtureReserve();
    r.oracles.switchboardPrice = null;
    r.oracles.switchboardTwap = null;
    const a = buildKaminoDepositRemainingAccounts(r, fixturePerUser());
    // pyth + scope present
    expect(a[6].pubkey).toEqual(r.oracles.pyth);
    expect(a[9].pubkey).toEqual(r.oracles.scope);
    // missing slots use klend program as sentinel
    expect(a[7].pubkey).toEqual(r.klendProgram);
    expect(a[8].pubkey).toEqual(r.klendProgram);
  });

  it('no entry is a signer — all signing happens via PDAs inside the adapter', () => {
    const a = buildKaminoDepositRemainingAccounts(fixtureReserve(), fixturePerUser());
    for (const acct of a) expect(acct.isSigner).toBe(false);
  });
});

describe('buildKaminoWithdrawRemainingAccounts (ra_withdraw_per_user)', () => {
  it('has exactly 20 entries — MIN_LEN=20 (V2 ix wraps V1 + 4 oracles + 3 farm)', () => {
    const accts = buildKaminoWithdrawRemainingAccounts(
      fixtureReserve({ farmAttached: true }), fixturePerUser(),
    );
    expect(accts.length).toBe(20);
  });

  it('positional order matches programs/b402-kamino-adapter::ra_withdraw_per_user', () => {
    const r = fixtureReserve({ farmAttached: true });
    const u = fixturePerUser();
    const a = buildKaminoWithdrawRemainingAccounts(r, u);
    expect(a[0].pubkey).toEqual(r.reserve);                            // 0  withdraw_reserve
    expect(a[1].pubkey).toEqual(u.obligation);                         // 1  obligation
    expect(a[2].pubkey).toEqual(r.lendingMarket);                      // 2  lending_market
    expect(a[3].pubkey).toEqual(r.lendingMarketAuthority);             // 3  lending_market_authority
    expect(a[4].pubkey).toEqual(r.reserveCollateralReserveDestSupply); // 4  reserve_source_collateral
    expect(a[5].pubkey).toEqual(r.reserveCollateralMint);              // 5  reserve_collateral_mint
    expect(a[6].pubkey).toEqual(r.reserveLiquiditySupply);             // 6  reserve_liquidity_supply
    expect(a[7].pubkey).toEqual(u.ownerUsdcAta);                       // 7  user_destination_liquidity = ownerUsdcAta
    expect(a[8].pubkey).toEqual(TOKEN_PROGRAM_ID);                     // 8  collateral_token_program
    expect(a[9].pubkey).toEqual(TOKEN_PROGRAM_ID);                     // 9  liquidity_token_program
    expect(a[10].pubkey).toEqual(SYSVAR_INSTRUCTIONS);                 // 10 instructions_sysvar
    expect(a[11].pubkey).toEqual(r.reserveLiquidityMint);              // 11 reserve_liquidity_mint
    expect(a[12].pubkey).toEqual(u.ownerPda);                          // 12 owner_pda
    expect(a[13].pubkey).toEqual(r.oracles.pyth);                      // 13 oracle_pyth
    expect(a[16].pubkey).toEqual(r.oracles.scope);                     // 16 oracle_scope
    expect(a[17].pubkey).toEqual(u.obligationFarm);                    // 17 obligation_farm
    expect(a[18].pubkey).toEqual(r.reserveFarmCollateral);             // 18 reserve_farm_state
    expect(a[19].pubkey).toEqual(r.farmsProgram);                      // 19 farms_program
  });

  it('writable flags match adapter expectations', () => {
    const r = fixtureReserve({ farmAttached: true });
    const a = buildKaminoWithdrawRemainingAccounts(r, fixturePerUser());
    expect(a[0].isWritable).toBe(true);   // reserve
    expect(a[1].isWritable).toBe(true);   // obligation
    expect(a[2].isWritable).toBe(false);  // market
    expect(a[3].isWritable).toBe(false);  // market authority
    expect(a[4].isWritable).toBe(true);   // reserve source collateral
    expect(a[5].isWritable).toBe(true);   // collateral mint
    expect(a[6].isWritable).toBe(true);   // liquidity supply
    expect(a[7].isWritable).toBe(true);   // user_destination = ownerUsdcAta — Kamino credits USDC here
    expect(a[8].isWritable).toBe(false);  // token programs
    expect(a[9].isWritable).toBe(false);
    // owner_pda must be WRITABLE — adapter signs FROM ownerUsdcAta to
    // sweep into adapter_out_ta post-CPI. Caught on surfpool 2026-05-05
    // when initially passed readonly.
    expect(a[12].isWritable).toBe(true);
    expect(a[13].isWritable).toBe(false); // oracles read-only
    expect(a[17].isWritable).toBe(true);  // obligation_farm — farm IS attached
    expect(a[18].isWritable).toBe(true);
    expect(a[19].isWritable).toBe(false); // farms_program is a program
  });

  it('no-farm reserve uses klend sentinel + readonly farm slots', () => {
    const r = fixtureReserve({ farmAttached: false });
    const a = buildKaminoWithdrawRemainingAccounts(r, fixturePerUser());
    expect(a[17].pubkey).toEqual(r.klendProgram);
    expect(a[17].isWritable).toBe(false);
    expect(a[18].pubkey).toEqual(r.klendProgram);
    expect(a[18].isWritable).toBe(false);
  });
});
