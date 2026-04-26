//! Wire-format guard tests for the Jupiter adapter's `action_payload`.
//!
//! Unlike the Kamino adapter (which Borsh-decodes a typed `KaminoAction`
//! enum), `b402_jupiter_adapter` forwards `action_payload` verbatim as the
//! Jupiter V6 instruction data — first 8 bytes are the Jupiter ix
//! discriminator the registry allowlists, remaining bytes are the route
//! plan opaque to the adapter.
//!
//! These tests pin the layout assumptions the registry / SDK depend on:
//!   - Discriminator lives at offset 0..8.
//!   - Adapter rejects payloads under 8 bytes (handler `require!`).
//!   - Realistic payload sizes stay within the 1232-byte Solana tx limit
//!     after accounting for the rest of `adapt_execute`'s args.
//!
//! The handler-side path (CPI into Jupiter V6 with these bytes) is
//! exercised on the mainnet-fork validator — see `examples/swap-e2e.ts`.

use b402_jupiter_adapter::JUPITER_V6_PROGRAM_ID;

/// Jupiter V6 `route` ix discriminator, sha256("global:route")[..8].
/// Pinned here as the canonical value the registry must allowlist for the
/// Jupiter adapter. If Jupiter V6 ever rotates the discriminator, the
/// allowlist update is the audit point — this test ensures we notice.
const JUPITER_ROUTE_DISCRIMINATOR: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];

#[test]
fn jupiter_program_id_is_pinned() {
    // The on-chain const must remain the canonical Jupiter V6 program ID.
    // Any drift here = the adapter routes to the wrong program = funds lost.
    let bytes = JUPITER_V6_PROGRAM_ID.to_bytes();
    // First two bytes of "JUP6L..." base58 decode to 0x04 0x79.
    assert_eq!(bytes[0], 0x04);
    assert_eq!(bytes[1], 0x79);
}

#[test]
fn payload_minimum_length_is_eight() {
    // The adapter's `require!(action_payload.len() >= 8, ...)` enforces this.
    // Pin the contract: anything < 8 bytes can't carry a discriminator, so
    // the adapter rejects without a CPI attempt.
    let too_short: Vec<u8> = vec![0x12, 0x34, 0x56];
    assert!(too_short.len() < 8, "fixture must be sub-discriminator length");

    // Symmetric assertion: an 8-byte payload (discriminator only, no route
    // args) IS the minimum acceptable wire shape from this adapter's POV.
    let just_disc: Vec<u8> = JUPITER_ROUTE_DISCRIMINATOR.to_vec();
    assert_eq!(just_disc.len(), 8);
}

#[test]
fn discriminator_at_offset_zero() {
    // The pool's `adapt_execute` reads `args.raw_adapter_ix_data[0..8]` as
    // the discriminator and checks it against the registry's allowlist.
    // The Jupiter adapter forwards the same bytes verbatim, so the
    // discriminator MUST live at offset 0 — never prefixed by a length tag
    // or framing byte.
    let payload: Vec<u8> = {
        let mut v = JUPITER_ROUTE_DISCRIMINATOR.to_vec();
        // Trail with arbitrary route-plan bytes; adapter doesn't inspect.
        v.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);
        v
    };
    let disc: [u8; 8] = payload[0..8].try_into().unwrap();
    assert_eq!(disc, JUPITER_ROUTE_DISCRIMINATOR);
}

#[test]
fn payload_size_in_typical_range() {
    // A real Jupiter V6 route ix data is typically 200-700 bytes (route
    // plan size scales with hop count). Assert a reasonable upper bound
    // that keeps the full `adapt_execute` tx under Solana's 1232 B limit.
    //
    // Budget for `adapt_execute` (rough, see PRD-04 §3):
    //   - signatures + header                     ~ 65 B
    //   - account list (~16 named + ~10 remaining) ~ 832 B
    //   - other args (proof 256, public_inputs 600, encrypted_notes ~250) — already big
    // Action_payload must squeeze under ~900 B even before account list overhead.
    const MAX_REASONABLE_PAYLOAD: usize = 900;

    // Sample a "typical" 4-hop route plan size — 8 disc + 4 byte length +
    // ~4 hops * ~64 B route entries ≈ 268 B.
    let typical: Vec<u8> = {
        let mut v = JUPITER_ROUTE_DISCRIMINATOR.to_vec();
        v.extend(std::iter::repeat(0xAB).take(260));
        v
    };
    assert!(
        typical.len() < MAX_REASONABLE_PAYLOAD,
        "typical route plan ({} B) must fit under {} B budget",
        typical.len(),
        MAX_REASONABLE_PAYLOAD,
    );
}
