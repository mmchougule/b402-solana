//! Arcis matcher — pairwise sealed-bid auction for b402 private swaps.
//!
//! Two bidders independently encrypt a `SwapIntent` to the MXE. The MPC
//! computes whether their intents are mint-complementary and slippage-
//! compatible. If yes, emits a public `MatchResult` with the cleared
//! sizes; if no, the `matched` flag is false and the result drives a
//! fallback (e.g. unmatched bid falls back to a public Jupiter route).
//!
//! Mint encoding: 1-byte ID maps to a known mint via the on-chain
//! `mint_registry` (kept off-chain in the SDK / settlement layer). For
//! the v1 demo: 0 = USDC, 1 = SOL, 2 = BONK.
//!
//! Privacy property: the MPC sees only the ciphertexts (encrypted to
//! `Mxe` — MXE-only decryption). The match result is plaintext so
//! settlement can fire off it, but the link between submitter wallet
//! and bid_idx stays private as long as bids are routed via a relayer.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Encrypted swap intent. Submitted by a bidder; only the MXE
    /// decrypts during matching.
    pub struct SwapIntent {
        /// Stable per-batch index assigned by the on-chain Anchor
        /// program at submission time. Lets a bidder later identify
        /// "did my bid win?" without revealing identity on chain.
        pub bid_idx: u8,
        /// Source-token ID (registry lookup off-chain).
        pub in_mint_id: u8,
        /// Destination-token ID.
        pub out_mint_id: u8,
        /// Amount of in_mint the bidder is willing to pay (base units).
        pub in_amount: u64,
        /// Minimum amount of out_mint the bidder requires (base units).
        /// Slippage protection — match must clear at >= this rate.
        pub min_out_amount: u64,
    }

    /// Plaintext match output. Emitted as a public event from the
    /// callback so any client/relayer can act on it.
    pub struct MatchResult {
        /// 1 = the pair cleared; 0 = no match (mints incompatible or
        /// slippage uncrossed). Bidders should check this first.
        pub matched: u8,
        /// First bidder's index from their SwapIntent.
        pub a_idx: u8,
        /// Second bidder's index.
        pub b_idx: u8,
        /// What A pays in (their in_amount on success; 0 on no-match).
        pub a_in: u64,
        /// What A receives out (B's in_amount on success).
        pub a_out: u64,
        /// What B pays in.
        pub b_in: u64,
        /// What B receives out.
        pub b_out: u64,
        /// in_mint_id of A (= out_mint_id of B on a match).
        pub a_in_mint: u8,
        /// out_mint_id of A (= in_mint_id of B on a match).
        pub a_out_mint: u8,
    }

    /// Pairwise sealed-bid match.
    ///
    /// Both inputs are `Enc<Mxe, _>` — encrypted to the MXE's pubkey by
    /// each bidder independently. The cipher inputs come from two
    /// different x25519 keys; MXE decrypts inside the MPC sandbox.
    ///
    /// Match rule (v1 — pairwise, midpoint clearing):
    ///   1. Mints must cross: a.in == b.out AND a.out == b.in.
    ///   2. Each bidder's `min_out_amount` must be satisfied by the
    ///      other's `in_amount` (cross-spread, no AMM curve in v1).
    ///   3. If both hold, A receives B's full `in_amount` and pays
    ///      their full `in_amount`; B mirrors. Sizes are not netted
    ///      in v1 — leftover capital is the bidder's problem.
    #[instruction]
    pub fn match_pair(
        bid_a: Enc<Mxe, SwapIntent>,
        bid_b: Enc<Mxe, SwapIntent>,
    ) -> MatchResult {
        let a = bid_a.to_arcis();
        let b = bid_b.to_arcis();

        // Mint complementarity: A in == B out AND A out == B in.
        let mints_match =
            (a.in_mint_id == b.out_mint_id) & (a.out_mint_id == b.in_mint_id);

        // Slippage compatibility: each side gets at least their min_out.
        let a_satisfied = b.in_amount >= a.min_out_amount;
        let b_satisfied = a.in_amount >= b.min_out_amount;
        let slippage_ok = a_satisfied & b_satisfied;

        let matched_bool = mints_match & slippage_ok;
        // Branchless: zero amounts on no-match so we never reveal which
        // partial condition failed.
        let m_mul = matched_bool as u64;
        let a_in = a.in_amount * m_mul;
        let b_in = b.in_amount * m_mul;

        MatchResult {
            matched: matched_bool as u8,
            a_idx: a.bid_idx,
            b_idx: b.bid_idx,
            a_in,
            a_out: b_in,
            b_in,
            b_out: a_in,
            a_in_mint: a.in_mint_id,
            a_out_mint: a.out_mint_id,
        }
        .reveal()
    }
}
