# Concept Frontmatter

Every OKF concept begins with a YAML frontmatter block. The one required key
is `type`. Producers may add arbitrary keys; consumers must not reject a
bundle for carrying keys they do not understand.

Common keys include `title` and `description`, both used to render a
directory's `index.md` listing. Values are scalars or flow-style lists.
