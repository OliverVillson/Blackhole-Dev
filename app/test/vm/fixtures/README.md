A stand-in `blackhole_pipeline` for the ssh end-to-end tests: the real CLI (`--job`, `--recipe`,
`--from`) and event shape, seconds instead of hours. On the test host:

    python3 -m venv ~/bh-venv
    cp -r blackhole_pipeline "$(~/bh-venv/bin/python -c 'import site; print(site.getsitepackages()[0])')/"

plus a `nvidia-smi` on PATH that prints `NAME, MEM_MIB, USED_MIB, UTIL` (the probe reads it).
