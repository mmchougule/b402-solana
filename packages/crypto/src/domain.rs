//! Domain tags per PRD-02 §1.2.
//!
//! Every Poseidon call in b402 prepends a domain tag so that outputs from
//! different purposes (commitment, nullifier, merkle node, ...) cannot be
//! confused. Tags are ASCII strings interpreted as big-endian integers,
//! reduced mod p.

use crate::Fr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DomainTag {
    Commit,
    Nullifier,
    MerkleNode,
    MerkleZero,
    NoteEncKey,
    SpendKey,
    SpendKeyPub,
    ViewKey,
    ViewTag,
    FeeBind,
    RootBind,
    AdaptBind,
    Disclose,
}

impl DomainTag {
    pub const fn as_str(&self) -> &'static str {
        match self {
            DomainTag::Commit => "b402/v1/commit",
            DomainTag::Nullifier => "b402/v1/null",
            DomainTag::MerkleNode => "b402/v1/mk-node",
            DomainTag::MerkleZero => "b402/v1/mk-zero",
            DomainTag::NoteEncKey => "b402/v1/note-enc-key",
            DomainTag::SpendKey => "b402/v1/spend-key",
            DomainTag::SpendKeyPub => "b402/v1/spend-key-pub",
            DomainTag::ViewKey => "b402/v1/view-key",
            DomainTag::ViewTag => "b402/v1/viewtag",
            DomainTag::FeeBind => "b402/v1/fee-bind",
            DomainTag::RootBind => "b402/v1/root-bind",
            DomainTag::AdaptBind => "b402/v1/adapt-bind",
            DomainTag::Disclose => "b402/v1/disclose",
        }
    }

    pub fn to_fr(self) -> Fr {
        Fr::from_tag(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tags_distinct() {
        let tags = [
            DomainTag::Commit,
            DomainTag::Nullifier,
            DomainTag::MerkleNode,
            DomainTag::MerkleZero,
            DomainTag::NoteEncKey,
            DomainTag::SpendKey,
            DomainTag::SpendKeyPub,
            DomainTag::ViewKey,
            DomainTag::ViewTag,
            DomainTag::FeeBind,
            DomainTag::RootBind,
            DomainTag::AdaptBind,
            DomainTag::Disclose,
        ];
        let frs: Vec<Fr> = tags.iter().map(|t| t.to_fr()).collect();
        for i in 0..frs.len() {
            for j in (i + 1)..frs.len() {
                assert_ne!(
                    frs[i], frs[j],
                    "tags {:?} and {:?} collide",
                    tags[i], tags[j]
                );
            }
        }
    }
}
