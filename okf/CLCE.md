Note: Common Logic Controlled English specification of auto-okf, focused on its
load-bearing structures: the op log, the deterministic fold, the regenerable
faces, and per-field merge. Declarations come first. Node modifiers are joined
with underscores (section 3, rule 5). All commentary lives in Note imperatives,
which the CLCE processor ignores. Meaning is only the first-order translation;
the controlled language is specified at jfsowa.com/clce/specs.htm. Where a claim
needs arithmetic, sequence order, or quantification over every linearization
beyond the declared vocabulary, it stays in a Note — the same discipline the
b_tree specification keeps.

Declare vault as noun,
        op as noun (x1 op of x2),
        writer as noun (x1 writer of x2),
        indexer as noun (x1 indexer of x2),
        core as functional noun (x1 core of x2),
        tag as functional noun (x1 tag of x2),
        seq as functional noun (x1 seq of x2),
        view as functional noun (x1 view of x2),
        concept as noun (x1 concept of x2),
        origin as functional noun (x1 origin of x2),
        identity as functional noun (x1 identity of x2),
        field as noun (x1 field of x2),
        register as noun,
        or_set as noun,
        value as functional noun (x1 value of x2),
        member as noun (x1 member of x2),
        path as functional noun (x1 path of x2),
        body as functional noun (x1 body of x2),
        revision as noun (x1 revision of x2),
        rev_hash as functional noun (x1 rev_hash of x2),
        base as functional noun (x1 base of x2),
        head as functional noun (x1 head of x2),
        face as noun (x1 face of x2),
        bundle as noun,
        markdown_file as noun (x1 markdown_file of x2),
        flag as noun (x1 flag of x2),
        generation as functional noun (x1 generation of x2),
        predecessor as functional noun (x1 predecessor of x2),
        genesis as adjective,
        authoritative as adjective,
        deterministic as adjective,
        superseded as adjective,
        wanted as adjective,
        appends as verb (theme appends to instrument),
        folds as verb (theme folds into instrument),
        materializes as verb (agent materializes theme from source),
        contains as verb (instrument contains theme),
        refers as verb (instrument refers to theme),
        adds as verb (agent adds theme to instrument),
        removes as verb (agent removes theme from instrument),
        observes as verb (agent observes theme),
        admits as verb (agent admits theme).

Note: The log is the source of truth.

Every op is an op of some writer.

Every writer of a vault has some core.

Every op of a writer appends to the core of the writer.

No op removes an op.

Note: The two sentences above are the append-only guarantee. A deletion is a
tombstone, never a subtraction, so "no op removes an op" is the whole retention
model. The log of a vault is the total order of the ops of its writers; that
order is a sequence, and the draft spec gives no sequence vocabulary, so the
ordering itself stays in this Note and surfaces below only as an op's position.

Every op has some tag.

If an op y is not an op z, then the tag of y is not the tag of z.

Note: The tag of an op is the pair of the core of its writer and the seq of the
op — a writer_key concatenated with a seq. Concatenation is a string function
beyond the declared arithmetic, so the construction stays here; downstream the
tag is an opaque, unique identity and the observation token for or_sets.

Note: The view is a deterministic fold.

Every vault has some view.

Every op of a vault folds into the view of the vault.

The view of a vault is deterministic.

Note: "Deterministic" is declared as an opaque adjective, but its content is the
central invariant (I1, I2): the apply function folds the linearized log into the
view using no wall clock, no randomness, and no peer-local read, so any two
writers holding the same log compute the same view. That is a claim about every
linearization on every peer — a quantification over models that first-order CLCE
cannot carry — so the universal stays in this Note and the adjective marks its
conclusion.

Note: Identity is minted once and never moves.

Every concept of a vault has some op as origin.

The identity of a concept is the tag of the origin of the concept.

The identity of a concept is not the path of the concept.

The identity of a concept is not the body of the concept.

If a concept y is not a concept z, then the identity of y is not the identity
of z.

Note: Identity is minted from the creating op's tag, and is neither the location
nor the content. A concept survives a rename (its path changes) and a deletion
(a tombstone keeps its identity), so the two "is not" sentences are the point:
the path and the body may move or vanish; the identity does not. CLCE has no
tense, so "survives" cannot be said directly — it is the absence of any op that
changes the identity, stated here.

Note: Merge is per field.

Every field of a concept is either a register or an or_set.

Every register has one value.

If a value of a register is superseded, then the register has some flag.

Note: The two sentences above are the LWW law (I6). Concurrent writes to a
scalar field do not both survive: apply keeps one deterministic winner, and the
superseded value leaves a flag/clobber. "One value" plus "some flag" is
no-silent-loss for registers.

Every member of an or_set has some tag.

If an agent adds a member to an or_set, then the or_set contains the member.

If an agent removes a member from an or_set, then the agent observes the tag of
the member.

Note: The two sentences above are the OR-set law (I5), SU-set semantics: an add
always lands, and a remove reaches only members whose tags the remover observed,
so a concurrent add — carrying a tag the remover never saw — beats the remove.
The tag is the observation token; "observe" quantifies over seen tags, which the
monadic vocabulary only gestures at, so the witnessing stays partly in this Note.

Note: Bodies are immutable revisions.

Every body of a concept has some head.

Every revision of a body has some rev_hash.

Every revision of a body has some base, or has no base.

If a revision y is a revision of a body,
   and a revision z is a revision of the body,
   and the base of y is the base of z,
   and y is not z,
   then the body has some flag.

Note: The previous sentence is the conflict law (I7). Two edits from the same
base are genuine concurrency: both revisions are kept, the head is set
deterministically, and exactly one flag/conflict is written until a
resolve-conflict op settles it. A rev_hash is the SHA-256 of the base pointer
and the NFC-normalized text; a fabricated base can never displace real ancestry,
which is a property of the hash and stays in this Note.

Note: Faces are regenerable projections.

Every bundle of a view is a face.

No face of a view is authoritative.

Every markdown_file of a bundle is a face of some concept.

If an agent materializes a bundle from a view, then the bundle is deterministic.

Note: A bundle is a pure projection of the view (I9): for a converged view,
materialize writes byte-identical output, so two peers produce the same bundle.
"Byte-identical" is string equality over a file tree — a sequence claim outside
the declared functions — so "deterministic" marks it and the byte equality stays
here. materialize never removes a markdown_file it did not itself produce; a
human edit re-enters the log as the minimal set of ops, so no face is ever the
source.

Note: Wanted is demand, not error.

If a body of a concept refers to a path,
   and no concept of the vault has the path,
   then the path is wanted.

No wanted path is a flag.

Note: An unresolved reference is a red link in Cunningham's sense: the target is
legitimately unwritten. It is ranked in the wanted index by referrer count, and
it is emphatically not a flag — an unwritten concept is healthy state, never a
loss. This is the line no-silent-loss draws: a flag is for something that needs
attention; a wanted path is for work that has not happened yet.

Note: Governance and genesis.

Every indexer of a vault is a writer of the vault.

If a writer y is an indexer of a vault x,
   and y is not the genesis writer of x,
   then some indexer of x admits y.

The genesis writer of a vault is an indexer of the vault.

No indexer admits the genesis writer of a vault.

Note: The previous two sentences are the trust anchor. Every indexer's authority
traces back, through some admitter, to one writer that no one admitted — the
genesis writer, the vault creator, seeded as the first indexer by construction.
This is autobee's own genesis, the referrer-null bootstrap. It is a different
word from the vault's generation below.

Note: Generations.

Every vault has some generation.

If a vault has no predecessor, then the generation of the vault is root.

If a vault y is the predecessor of a vault x,
   then the generation of x is not the generation of y.

Note: A generation is one incarnation of a vault produced by compaction:
materialize the live bundle, then seed a fresh vault whose writer keys cannot
recur. The generation of a non-root vault is the SHA-256 of its predecessor's
key and the predecessor's checkpoint — a hash chain, so the generation of a
vault is never the generation of its predecessor. The hash construction is
beyond the declared functions and stays in this Note; the "is not" sentence is
its visible consequence.

Is it true that some face of a view is authoritative?

Note: The question is answerable from the axioms above. Your turn.
