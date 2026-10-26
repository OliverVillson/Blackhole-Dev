// Python run on the host with its system python3 over ssh stdin. Kept as real .py files so they
// can be read, linted and tested on their own.
import PROBE_PY from "./probe.py?raw";
import STOP_PY from "./stop.py?raw";

export { PROBE_PY, STOP_PY };
