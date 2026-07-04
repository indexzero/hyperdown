#!/usr/bin/env node
// autovault-ld — CLI veneer over @autovault-ld/{core,store,faces} (SPEC-FINAL §13).
import { run } from '../lib/run.js'

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(`autovault-ld: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
)
