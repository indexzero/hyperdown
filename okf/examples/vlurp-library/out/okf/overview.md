---
_id: "5257cb0068cadb71f290c2fd7aea9f9b9807f1f7567510c6ecf4b9e3fe62a4280"
_rev: "044a8f1122fd516e5c252fb26f8f24dcf1f302d223db3229c907fd51b68e435b"
type: context
ref: "0.1.0"
sha256: "5594a4f5141b00f2e9326d1d8e50c2eda105d970a463a08dcc879ad69119f9f2"
source: "https://github.com/GoogleCloudPlatform/knowledge-catalog"
title: OKF Overview
---

# OKF Overview

The Open Knowledge Format (OKF) is a convention for representing a knowledge
base as a directory of Markdown files with YAML frontmatter. Each file is a
concept; links between concepts are ordinary Markdown links. A bundle is
self-describing: an `index.md` per directory and a root `log.md` narrate it.

OKF is deliberately small. It says nothing about storage, transport, or
merge — only about the shape of the emitted tree — so any producer can write
a conformant bundle and any consumer can read one.
