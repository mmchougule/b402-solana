//! Property tests for the mapping table (PRD-36 §6.2).
//!
//! Property: for any sequence of (init, close) operations on the same
//! viewing_pub_hash, the table state is invariant — at most one open
//! entry per hash; closed entries are correctly filtered from lookup;
//! the sorted-prefix invariant holds after every mutation.

use b402_percolator_adapter::{
    mapping::{self, AllocateOutcome, FLAG_CLOSED, MAX_ENTRIES, PERP_MAPPING_ACCOUNT_LEN},
    PerpMapping, PerpMappingRead, ViewingPubHash,
};
use proptest::prelude::*;

#[derive(Debug, Clone)]
enum Op {
    Init { hash_idx: u8, user_idx: u16 },
    Close { hash_idx: u8 },
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u8..16, 0u16..200).prop_map(|(h, u)| Op::Init {
            hash_idx: h,
            user_idx: u
        }),
        (0u8..16).prop_map(|h| Op::Close { hash_idx: h }),
    ]
}

fn h(idx: u8) -> ViewingPubHash {
    let mut hash = [0u8; 32];
    hash[31] = idx;
    hash
}

fn slab() -> [u8; 32] {
    [0x77; 32]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn sorted_invariant_holds_under_arbitrary_ops(
        ops in proptest::collection::vec(op_strategy(), 1..50),
    ) {
        let mut buf = vec![0u8; PERP_MAPPING_ACCOUNT_LEN];
        {
            let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
            m.initialize(&slab(), 0).unwrap();
        }

        // Track expected state.
        let mut live: std::collections::BTreeMap<u8, u16> = std::collections::BTreeMap::new();
        let mut closed: std::collections::BTreeSet<u8> = std::collections::BTreeSet::new();

        for op in &ops {
            // Re-borrow each iteration so the read-side checks below can
            // immutably borrow the same buffer without a conflict.
            {
                let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
                match op {
                    Op::Init { hash_idx, user_idx } => {
                        m.record_init(&h(*hash_idx), *user_idx).unwrap();
                        live.insert(*hash_idx, *user_idx);
                        closed.remove(hash_idx);
                    }
                    Op::Close { hash_idx } => {
                        if live.contains_key(hash_idx) {
                            let returned = m.record_close(&h(*hash_idx)).unwrap();
                            prop_assert_eq!(returned, live[hash_idx]);
                            closed.insert(*hash_idx);
                            live.remove(hash_idx);
                        } else if closed.contains(hash_idx) {
                            m.record_close(&h(*hash_idx)).unwrap();
                        } else {
                            let result = m.record_close(&h(*hash_idx));
                            prop_assert_eq!(result, Err(mapping::MappingError::NotFound));
                        }
                    }
                }
            }

            // Sorted invariant + lookup parity, immutable view.
            let read = PerpMappingRead::from_bytes(&buf).unwrap();
            // (Sorted check via direct buffer read — entry layout is part
            // of the public ENTRY_SIZE / HEADER_SIZE constants.)
            let count = read_entry_count(&buf) as usize;
            for i in 1..count {
                let prev = read_hash(&buf, i - 1);
                let cur = read_hash(&buf, i);
                prop_assert!(prev < cur, "sorted invariant broken at i={i}");
            }
            for (&hash_idx, &user_idx) in live.iter() {
                prop_assert_eq!(read.lookup(&h(hash_idx)), Some(user_idx));
            }
            for &hash_idx in closed.iter() {
                prop_assert_eq!(read.lookup(&h(hash_idx)), None);
            }
        }
    }

    #[test]
    fn closed_entries_can_be_reactivated(
        seq in proptest::collection::vec(0u8..8, 1..20),
    ) {
        let mut buf = vec![0u8; PERP_MAPPING_ACCOUNT_LEN];
        {
            let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
            m.initialize(&slab(), 0).unwrap();

            m.record_init(&h(5), 100).unwrap();
            m.record_close(&h(5)).unwrap();
            prop_assert_eq!(
                m.allocate(&h(5)),
                AllocateOutcome::PrevClosed { user_idx: 100 }
            );
            m.record_init(&h(5), 200).unwrap();
            prop_assert_eq!(
                m.allocate(&h(5)),
                AllocateOutcome::Existing { user_idx: 200 }
            );

            for &x in seq.iter() {
                if x == 5 { continue; }
                prop_assert_eq!(m.allocate(&h(x)), AllocateOutcome::NewSlotNeeded);
            }
        }
    }
}

fn read_entry_count(buf: &[u8]) -> u16 {
    u16::from_le_bytes(buf[42..44].try_into().unwrap())
}

fn read_hash(buf: &[u8], idx: usize) -> [u8; 32] {
    use b402_percolator_adapter::mapping::{ENTRY_SIZE, HEADER_SIZE};
    let base = HEADER_SIZE + idx * ENTRY_SIZE;
    let mut out = [0u8; 32];
    out.copy_from_slice(&buf[base..base + 32]);
    out
}

// Compile-time sanity: the constants we reference are exported and not
// drifting. (Belt-and-braces against an accidental rename in `mapping.rs`.)
#[allow(dead_code)]
const _: usize = MAX_ENTRIES;
#[allow(dead_code)]
const _F: u16 = FLAG_CLOSED;
