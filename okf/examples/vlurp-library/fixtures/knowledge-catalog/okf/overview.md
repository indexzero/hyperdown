# OKF Overview

The Open Knowledge Format (OKF) is a convention for representing a knowledge
base as a directory of Markdown files with YAML frontmatter. Each file is a
concept; links between concepts are ordinary Markdown links. A bundle is
self-describing: an `index.md` per directory and a root `log.md` narrate it.

OKF is deliberately small. It says nothing about storage, transport, or
merge — only about the shape of the emitted tree — so any producer can write
a conformant bundle and any consumer can read one.
