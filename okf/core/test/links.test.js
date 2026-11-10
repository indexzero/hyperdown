// Link extraction and target resolution (SPEC §9). apply derives link/, bl/
// and wanted/ from these functions, so one wrong target here gives a wrong
// index on every peer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractLinks, normalizeLinkTarget, resolveTarget, dirOf } from '../lib/links.js'

const links = (text, sourceDir) => [...extractLinks(text, sourceDir)].sort()

test('§9: extractLinks returns an empty set for an empty or absent text', () => {
  for (const text of ['', null, undefined]) {
    const out = extractLinks(text)
    assert.ok(out instanceof Set)
    assert.equal(out.size, 0)
  }
})

test('§9: an inline link gives its target, with or without a title or angle brackets', () => {
  assert.deepEqual(links('see [a](/x/plain), [b](/x/titled "A title") and [c](</x/angled>)'), [
    'x/angled',
    'x/plain',
    'x/titled'
  ])
})

test('§9: two links to one target give one entry', () => {
  assert.deepEqual(links('[a](/x/y) and [b](/x/y.md) and [c](/x/./y#frag)'), ['x/y'])
})

test('§9: an image is not a link, in inline, full reference and shortcut form', () => {
  const text = ['![a](/img/inline) ![b][ref] ![ref]', '', '[ref]: /img/ref'].join('\n')
  assert.deepEqual(links(text), [])
})

test('§9: full, collapsed and shortcut reference links resolve through their definitions', () => {
  const text = [
    '[text][full] then [collapsed][] then [short]',
    '',
    '[full]: /r/full',
    '[collapsed]: /r/collapsed',
    '   [short]: /r/short "A title"'
  ].join('\n')
  assert.deepEqual(links(text), ['r/collapsed', 'r/full', 'r/short'])
})

test('§9: a reference label matches without case and with collapsed whitespace', () => {
  const text = ['[text][My   LABEL] and [  my label  ]', '', '[my label]: /r/label'].join('\n')
  assert.deepEqual(links(text), ['r/label'])
})

test('§9: the first definition of a label wins', () => {
  const text = ['[d]', '', '[d]: /r/first', '[D]: /r/second'].join('\n')
  assert.deepEqual(links(text), ['r/first'])
})

test('§9: a reference with no definition gives no link', () => {
  assert.deepEqual(links('[text][missing] and [missing][] and [missing]'), [])
})

test('§9: a definition that no reference uses gives no link', () => {
  // extractLinks blanks the definition lines. If it does not, the shortcut
  // pass reads `[unused]` in the definition itself as a reference.
  assert.deepEqual(links('[unused]: /r/unused'), [])
})

test('§9: a reference definition resolves against the source directory', () => {
  const text = ['[rel]', '', '[rel]: ../sibling.md#part'].join('\n')
  assert.deepEqual(links(text, 'a/b'), ['a/sibling'])
})

test('§9: links in fenced and indented code blocks are skipped', () => {
  const text = [
    '[before](/before)',
    '```',
    '[in-backtick](/in-backtick)',
    '~~~',
    '[other-fence-char](/other-fence-char)',
    '```',
    '[between](/between)',
    '   ~~~~js',
    '[in-tilde](/in-tilde)',
    '~~~',
    '    [indented](/indented)',
    '\t[tabbed](/tabbed)',
    '[after](/after)'
  ].join('\n')
  assert.deepEqual(links(text), ['after', 'before', 'between'])
})

test('§9: a fence that never closes skips every line after it', () => {
  assert.deepEqual(links(['[before](/before)', '```', '[lost](/lost)', '', '[lost2](/lost2)'].join('\n')), ['before'])
})

test('§9: links in inline code spans are skipped', () => {
  assert.deepEqual(links('`[one](/one)` and ``[two](/two)`` and [kept](/kept) and `[ref]`\n\n[ref]: /ref'), ['kept'])
})

test('§9: a target with a URI scheme is a citation, not a link', () => {
  for (const raw of ['https://example.com/a', 'HTTP://example.com', 'mailto:a@example.com', 'x-app+v1.2:thing', 'C:/drive', '<https://example.com>']) {
    assert.equal(normalizeLinkTarget(raw, ''), null, raw)
  }
  assert.deepEqual(links('[a](https://example.com/a) [b](mailto:a@example.com) [c](/kept)'), ['kept'])
})

test('§9: a protocol-relative target is a citation, not a link', () => {
  assert.equal(normalizeLinkTarget('//cdn.example.com/x', 'a'), null)
  assert.deepEqual(links('[a](//cdn.example.com/x)'), [])
})

test('§9: a target with a `/` prefix resolves from the bundle root, whatever the source directory', () => {
  assert.equal(normalizeLinkTarget('/x/y', ''), 'x/y')
  assert.equal(normalizeLinkTarget('/x/y', 'deep/dir'), 'x/y')
})

test('§9: a relative target resolves from the source directory', () => {
  assert.equal(normalizeLinkTarget('y', ''), 'y')
  assert.equal(normalizeLinkTarget('y', 'deep/dir'), 'deep/dir/y')
  assert.equal(normalizeLinkTarget('sub/y', 'deep'), 'deep/sub/y')
  assert.deepEqual(links('[a](y)'), ['y'], 'the source directory defaults to the bundle root')
})

test('§9: `.`, `..` and empty segments normalize away', () => {
  assert.equal(normalizeLinkTarget('./x', 'a/b'), 'a/b/x')
  assert.equal(normalizeLinkTarget('../x', 'a/b'), 'a/x')
  assert.equal(normalizeLinkTarget('../../x', 'a/b'), 'x')
  assert.equal(normalizeLinkTarget('c/./d/../e', 'a/b'), 'a/b/c/e')
  assert.equal(normalizeLinkTarget('c//d/', 'a'), 'a/c/d')
  assert.equal(normalizeLinkTarget('/a/../b', 'ignored'), 'b')
  assert.equal(resolveTarget('x/../y', ''), 'y')
  assert.equal(resolveTarget('..', 'a/b'), 'a')
  assert.equal(resolveTarget('.', ''), '')
})

test('§9: a target that escapes the bundle root gives no link', () => {
  assert.equal(resolveTarget('../x', ''), null)
  assert.equal(resolveTarget('../../../x', 'a/b'), null)
  assert.equal(resolveTarget('a/../../x', ''), null)
  assert.equal(normalizeLinkTarget('../x', ''), null)
  assert.equal(normalizeLinkTarget('/../x', 'a/b'), null, 'a `/` prefix does not resolve from the source directory')
  // A climb above the root that comes back down is still an escape.
  assert.equal(normalizeLinkTarget('../../a/x', 'a'), null)
  assert.deepEqual(links('[up](../../../x) [ok](../x)', 'a/b'), ['a/x'])
})

test('§9: a target that normalizes to the bundle root gives no link', () => {
  for (const [raw, dir] of [['/', 'a'], ['.', ''], ['./', ''], ['..', 'a'], ['', 'a'], ['<>', 'a']]) {
    assert.equal(normalizeLinkTarget(raw, dir), null, `${JSON.stringify(raw)} from ${JSON.stringify(dir)}`)
  }
})

test('§9: one trailing `.md` is stripped, in any case', () => {
  assert.equal(normalizeLinkTarget('/a/b.md', ''), 'a/b')
  assert.equal(normalizeLinkTarget('/a/b.MD', ''), 'a/b')
  assert.equal(normalizeLinkTarget('b.md', 'a'), 'a/b')
  assert.equal(normalizeLinkTarget('/a/b.md.md', ''), 'a/b.md', 'only one suffix')
  assert.equal(normalizeLinkTarget('/a.md/b', ''), 'a.md/b', 'only at the end')
  assert.equal(normalizeLinkTarget('/a/bmd', ''), 'a/bmd', 'the dot is part of the suffix')
})

test('§9: a target that is only `.md` gives no link', () => {
  assert.equal(normalizeLinkTarget('/.md', ''), null)
  assert.equal(normalizeLinkTarget('.md', ''), null)
})

test('§9: a fragment is stripped, and a target that is only a fragment gives no link', () => {
  assert.equal(normalizeLinkTarget('/a/b#section', ''), 'a/b')
  assert.equal(normalizeLinkTarget('/a/b.md#section', ''), 'a/b', 'the fragment goes before the `.md` suffix')
  assert.equal(normalizeLinkTarget('b#one#two', 'a'), 'a/b')
  assert.equal(normalizeLinkTarget('#section', 'a'), null)
  assert.deepEqual(links('[here](#section) [there](other#section)', 'a'), ['a/other'])
})

test('§9: a target is NFC, so an NFD and an NFC spelling give one link', () => {
  const nfd = 're\u0301union'
  const nfc = 'r\u00e9union'
  assert.equal(normalizeLinkTarget('/notes/' + nfd, ''), 'notes/' + nfc)
  assert.deepEqual(links(`[a](/notes/${nfd}) [b](/notes/${nfc})`), ['notes/' + nfc])
})

test('§9: dirOf gives the directory of a path, and the empty string at the bundle root', () => {
  assert.equal(dirOf('a/b/c'), 'a/b')
  assert.equal(dirOf('a/b'), 'a')
  assert.equal(dirOf('a'), '')
  assert.equal(dirOf(''), '')
})
