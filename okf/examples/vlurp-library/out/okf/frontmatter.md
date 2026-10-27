---
_id: "5257cb0068cadb71f290c2fd7aea9f9b9807f1f7567510c6ecf4b9e3fe62a4286"
_rev: de521d94138a197d4af91897ea76d6d2ebba01c3c800e2dc4f4d3d69da7fad5e
type: context
ref: "0.1.0"
sha256: "2e6a5d2f046939e5e058f609536aa67d2469eee7a1708365ea28daaedb681e7d"
source: "https://github.com/GoogleCloudPlatform/knowledge-catalog"
title: Concept Frontmatter
---

# Concept Frontmatter

Every OKF concept begins with a YAML frontmatter block. The one required key
is `type`. Producers may add arbitrary keys; consumers must not reject a
bundle for carrying keys they do not understand.

Common keys include `title` and `description`, both used to render a
directory's `index.md` listing. Values are scalars or flow-style lists.

