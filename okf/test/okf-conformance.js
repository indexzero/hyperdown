// An OKF v0.1 conformance checker for a bundle directory (OKF §9).
// Do not import the parser or the emitter of @auto-okf/faces here. A bug in
// the emitter then passes its own check.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Every `.md` file under root, as relative paths with forward slashes on every platform. */
async function listMarkdown(root, rel = '', out = []) {
  const abs = rel === '' ? root : join(root, rel)
  for (const e of await readdir(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await listMarkdown(root, childRel, out)
    else if (e.isFile() && childRel.endsWith('.md')) out.push(childRel)
  }
  return out
}

/** Split a file into { frontmatter: string|null, body: string }. */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { frontmatter: null, body: text }
  const m = /\n---(?:\n|$)/.exec(text.slice(3))
  if (!m) return { frontmatter: null, body: text }
  const end = 3 + m.index
  const yamlSrc = text.slice(4, end + 1)
  const after = text.indexOf('\n', end + 1)
  const body = after === -1 ? '' : text.slice(after + 1)
  return { frontmatter: yamlSrc, body }
}

function isReserved(rel) {
  const name = rel.split('/').pop().toLowerCase()
  return name === 'index.md' || name === 'log.md'
}

/** Returns { ok, violations: [{ file, rule, message }], files }. A pass says nothing about determinism. */
export async function checkOkfConformance(root) {
  const violations = []
  const files = (await listMarkdown(root)).sort()

  for (const rel of files) {
    const text = await readFile(join(root, rel), 'utf8')
    if (isReserved(rel)) {
      const name = rel.split('/').pop().toLowerCase()
      if (name === 'index.md') checkIndex(rel, text, violations)
      else checkLog(rel, text, violations)
      continue
    }
    const { frontmatter } = splitFrontmatter(text)
    if (frontmatter === null) {
      violations.push({ file: rel, rule: 1, message: 'no YAML frontmatter block' })
      continue
    }
    let fm
    try {
      fm = parseYaml(frontmatter)
    } catch (err) {
      violations.push({ file: rel, rule: 1, message: 'frontmatter YAML parse error: ' + err.message })
      continue
    }
    if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
      violations.push({ file: rel, rule: 1, message: 'frontmatter is not a mapping' })
      continue
    }
    const type = fm.type
    if (typeof type !== 'string' || type.trim() === '') {
      violations.push({ file: rel, rule: 2, message: 'missing or empty `type`' })
    }
  }

  return { ok: violations.length === 0, violations, files }
}

/** The index.md rules of OKF §6. */
function checkIndex(rel, text, violations) {
  const isRoot = rel === 'index.md'
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter !== null) {
    if (!isRoot) {
      violations.push({ file: rel, rule: 3, message: 'non-root index.md must not have frontmatter (OKF §6)' })
    } else {
      let fm
      try {
        fm = parseYaml(frontmatter)
      } catch (err) {
        violations.push({ file: rel, rule: 3, message: 'root index frontmatter parse error: ' + err.message })
        fm = null
      }
      if (fm && typeof fm === 'object') {
        const extra = Object.keys(fm).filter((k) => k !== 'okf_version')
        if (extra.length > 0) {
          violations.push({ file: rel, rule: 3, message: 'root index frontmatter may only carry okf_version (OKF §11): ' + extra.join(',') })
        }
      }
    }
  }
  const lines = body.split('\n')
  let sawHeading = false
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) {
      sawHeading = true
      continue
    }
    if (line.trim() === '') continue
    if (/^\s*[*-]\s+/.test(line)) {
      if (!/^\s*[*-]\s+\[[^\]]*\]\([^)]*\)/.test(line)) {
        violations.push({ file: rel, rule: 3, message: 'index bullet is not a markdown link: ' + line })
      }
      continue
    }
    // OKF §6 allows other content in an index, so it is not a violation.
  }
  if (!sawHeading) {
    violations.push({ file: rel, rule: 3, message: 'index.md has no section heading (OKF §6)' })
  }
}

/** The log.md rules of OKF §7: a title, then ISO date headings. */
function checkLog(rel, text, violations) {
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter !== null) {
    violations.push({ file: rel, rule: 3, message: 'log.md must not have frontmatter (OKF §7)' })
  }
  const src = frontmatter !== null ? body : text
  const lines = src.split('\n')
  let sawTitle = false
  let sawDate = false
  for (const line of lines) {
    const h1 = /^#\s+(\S.*)$/.exec(line)
    if (h1) {
      sawTitle = true
      continue
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      sawDate = true
      if (!ISO_DATE.test(h2[1])) {
        violations.push({ file: rel, rule: 3, message: 'log date heading not ISO YYYY-MM-DD (OKF §7): ' + h2[1] })
      }
    }
  }
  if (!sawTitle) violations.push({ file: rel, rule: 3, message: 'log.md has no title heading (OKF §7)' })
  // A log with no dated entry is valid (an empty history), so sawDate is not a rule.
  void sawDate
}
