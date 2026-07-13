#!/usr/bin/env node
// hyperwiki — CLI veneer over @hyperwiki/{core,store,faces} (SPEC-FINAL §13).
import { run } from '../lib/run.js'

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(`hyperwiki: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
)
