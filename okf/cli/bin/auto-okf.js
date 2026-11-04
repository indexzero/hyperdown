#!/usr/bin/env node
// auto-okf: the CLI over @auto-okf/{core,store,faces}. See SPEC §13.
import { run } from '../lib/run.js'

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(`auto-okf: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
)
