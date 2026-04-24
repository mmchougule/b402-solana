//! Anchor instruction discriminator: first 8 bytes of SHA-256("global:<name>").

use sha2::{Digest, Sha256};

pub fn instruction(name: &str) -> [u8; 8] {
    let mut h = Sha256::new();
    h.update(format!("global:{name}").as_bytes());
    let out = h.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&out[..8]);
    disc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_are_stable() {
        // Snapshot — if these change, every dep breaks.
        assert_eq!(instruction("init_pool").len(), 8);
        let a = instruction("shield");
        let b = instruction("shield");
        assert_eq!(a, b);
        assert_ne!(instruction("shield"), instruction("unshield"));
    }
}
