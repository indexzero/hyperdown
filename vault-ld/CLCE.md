Note: Common Logic Controlled English specification of Vault-LD, focused on its
load-bearing structures: the statement tuple, the in-log context, per-predicate
merge policy, and the reflexive composition that is the system's narrow
contribution. Declarations come first. Node modifiers are joined with
underscores. All commentary lives in Note imperatives, which the CLCE processor
ignores. Meaning is only the first-order translation; the controlled language is
specified at jfsowa.com/clce/specs.htm. Vault-LD shares the op log, the
deterministic fold, the identity model, and the regenerable faces of auto-okf —
those axioms are stated in okf/CLCE.md and are not repeated here. This
specification states only what the linked-data layer adds.

Declare vault as noun,
        op as noun (x1 op of x2),
        writer as noun (x1 writer of x2),
        statement as noun (x1 statement of x2),
        triple as noun,
        subject as functional noun (x1 subject of x2),
        predicate as functional noun (x1 predicate of x2),
        object as functional noun (x1 object of x2),
        tag as functional noun (x1 tag of x2),
        term as noun (x1 term of x2),
        scope as noun (x1 scope of x2),
        iri as functional noun (x1 iri of x2),
        context as functional noun (x1 context of x2),
        apply as functional noun (x1 apply of x2),
        kind as functional noun (x1 kind of x2),
        register as noun,
        or_set as noun,
        ctx_kind as functional noun (x1 ctx_kind of x2),
        position as functional noun (x1 position of x2),
        view as functional noun (x1 view of x2),
        face as noun (x1 face of x2),
        markdown_vault as noun,
        turtle_export as noun,
        flag as noun (x1 flag of x2),
        privileged as adjective,
        authoritative as adjective,
        defines as verb (agent defines theme),
        asserts as verb (agent asserts theme for beneficiary),
        resolves as verb (agent resolves theme to result),
        folds as verb (agent folds theme into result),
        contains as verb (instrument contains theme).

Note: A statement is a triple with a tag.

Every statement of a vault is a triple.

Every triple has some subject.

Every triple has some predicate.

Every triple has some object.

Every statement has some tag.

Note: The tuple is [subject, predicate, object, tag] — a triple grown by one
member. The tag is the op that asserted the statement, and it is the same tag as
auto-okf: the OR-set observation token and the audit handle. Concurrent writers
merge at the level of statements, not files, and the fourth member is what lets
two assertions of the same subject and predicate be told apart.

Every predicate of a triple is a term.

Every term of a scope has some iri.

Note: A predicate is not a bare word. A term is declared in a scope — a
DefineScope op fixes a namespace prefix, and a DefineTerm op maps the term to an
iri, its @id. A markdown wiki-link and a frontmatter key each resolve, through
the context, to a term with an iri; that resolution is why the vault "is RDF" on
export.

Note: Merge policy is per predicate.

Every term has some kind.

Every kind of a term is either a register or an or_set.

If the kind of a term is a register,
   and a writer asserts some object for the term of a subject,
   and a writer asserts another object for the term of the subject,
   then the term of the subject has one object,
   and the term of the subject has some flag.

If the kind of a term is an or_set,
   and a writer asserts some object for the term of a subject,
   then the term of the subject contains the object.

Note: The kind is the merge policy: a register is last-writer-wins (one object
survives; the loser leaves a flag/clobber; I6) and an or_set unions across
writers (SU-set semantics; I5). The register law and the OR-set law themselves
are in okf/CLCE.md; what Vault-LD adds is that the policy is not fixed per field
but read from the term. auto-okf has one policy per field; Vault-LD chooses the
policy per predicate.

Note: The context is ordinary data in the same log.

Every vault has some context.

The context of a vault defines the kind of every term of the vault.

The context of a vault is not privileged.

The op that defines the context of a vault folds into the view of the vault by
the apply of the vault.

Every op of a vault folds into the view of the vault by the apply of the vault.

Note: The previous two sentences are the narrow contribution. The policy table —
the JSON-LD @context that decides each predicate's merge kind — has no
privileged channel: it is ordinary content in the very same single-total-order
log as the data, folded by the very same deterministic apply. Schema evolution
and data evolution therefore share one linearization, one determinism argument,
one governance regime. This is an engineering composition — SU-set semantics
plus an in-log mutable context — not a new merge theory.

Note: The kind is read at apply time.

If an op y asserts a term of a subject,
   then the context resolves the term of y to some kind at the position of y.

If an op y asserts a term of a subject,
   and the context resolves the term of y to a register at the position of y,
   and a reorder resolves the term of y to an or_set at the position of y,
   then the object of y merges under the kind at the position of y.

Note: Because the context is itself in the log, the kind a term resolves to
depends on where an op falls in the linearization. A reorder that moves a
DefineTerm across dependent writes can change an unpinned write's meaning —
deterministically, but surprisingly. "Position in the linearization" is the
sequence vocabulary the draft spec never gives, so the ordering stays in this
Note; its consequence is the context regime.

Note: Pinning, and the context regime.

Every op has some ctx_kind, or has no ctx_kind.

If an op y has some ctx_kind,
   and the ctx_kind of y is not the kind that the context resolves for the term
   of y at the position of y,
   then the object of y merges under the ctx_kind of y,
   and the vault has some flag.

Note: An op may pin the kind it was written against — its ctxKind. When the
resolved kind and the pinned kind disagree, the context regime has shifted under
a reorder: the op is applied under the cited kind, and the divergence is audited
under flag/kindshift. Nothing is silent — the shift is always a flag, never a
lost write. This is the context-regime caveat, and it is the only place the
apply-time-policy rule can surprise a reader, which is exactly why the flag
exists.

Note: Faces.

Every markdown_vault of a view is a face.

Every turtle_export of a view is a face.

No face of a view is authoritative.

Note: One view projects two ways: a markdown vault that reads like a wiki in
Obsidian, and a Turtle export — a schema face and a data face — that a triple
store can query. Both are regenerable projections of the log, and neither is the
source. A human edit to the markdown vault re-enters the log as ops, so the two
faces cannot drift into two truths.

Is it true that the context of a vault folds into the view of the vault by a
different apply than the data of the vault?

Note: The question is answerable from the axioms above. Your turn.
