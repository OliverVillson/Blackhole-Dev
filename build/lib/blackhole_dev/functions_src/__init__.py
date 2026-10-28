"""The built-in named functions, one readable file each.

Every preset recipe is built only from these, so anything a preset does a developer can read,
fork and change: `blackhole fn fork NAME` (or Fork in the app) copies the file into the user
functions folder, where a function of the same name replaces the built-in (see
blackhole_dev.functions for the override rule). Files starting with `_` are shared helpers.

Model-level functions (per tensor / part / model) work on the anatomy API; job-level ones
(per="job": traces, distil, qheal, bench, ...) are the pipeline's GPU stages, run on the VM
through blackhole_dev.jobctx."""
