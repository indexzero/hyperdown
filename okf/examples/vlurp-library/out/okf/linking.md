---
_id: "5257cb0068cadb71f290c2fd7aea9f9b9807f1f7567510c6ecf4b9e3fe62a428c"
_rev: a5d6dfc8d77150a8c7762f78b66895a853f92a4d84d9d659fbf8a7701efafc55
type: context
ref: "0.1.0"
sha256: "105013da7db43cfb87788bd7a8f3f1f19ba94812465dbe3aee692d168e660444"
source: "https://github.com/GoogleCloudPlatform/knowledge-catalog"
title: Linking Concepts
---

# Linking Concepts

Concepts link to each other with ordinary Markdown links, bundle-relative and
absolute-preferred: `[Frontmatter](/okf/frontmatter.md)`. A link whose target
does not resolve is not an error — OKF tolerates dangling links, treating them
as an invitation to write the missing concept later.

This "incremental" stance is inherited from the original wiki: the graph is
allowed to want pages that do not exist yet.
