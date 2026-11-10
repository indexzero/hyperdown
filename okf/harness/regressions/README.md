# Committed shrunk fuzz regressions live here.
#
# The S10 fuzz engine writes fuzz-seed-<seed>.json here when it finds a
# divergent view hash or an index-coherence violation, after shrinking the
# schedule to a minimal repro (okf/harness/lib/fuzz.js saveRegression). Each
# fixture is replayable via runSchedule(JSON.parse(...).schedule).
