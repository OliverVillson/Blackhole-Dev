"""Built-in function `traces`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork traces`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function
from blackhole_dev.functions_src._teacher import Teacher


@function("traces", per="job")
def traces(job, problems: int = 1024, samples: int = 4, max_tokens: int = 12288, think_budget: int = 0,
           keep: str = "shortest", seed: int = 1234, file: str = "") -> dict:
    """Verified shortest-trace distillation data (a BlackHole-Harness original). The teacher
    solves `problems` competitive-programming problems (deepmind/code_contests, pre-2022, so
    not in LiveCodeBench's newer releases, or your own `file` in LiveCodeBench's jsonl format)
    `samples` times each; every answer's code runs against the problem's tests on the CPU, and
    `keep` = "shortest" trains the student on the shortest answer that passed ("all": every
    passing answer). Only answers that ended on their own count. `think_budget` > 0 cuts
    thinking still open at that many tokens and tells the teacher to answer now (budget forcing).
    Writes work/heal_data.jsonl (rows {ids, start}) for distil, and work/heal_traces.json."""
    import os
    import random
    from concurrent.futures import ThreadPoolExecutor

    from reaper_pipeline.stages._common import write_jsonl

    from blackhole_pipeline.traces import contest_problems
    from blackhole_pipeline.bench import extract_code, load_problems, prompt, run_problem

    job.emit(pct=1, msg=f"loading {problems} problems")
    probs = load_problems(file=file, limit=problems) if file else contest_problems(problems, seed)
    teacher = Teacher.of(job)
    job.emit(pct=3, msg=f"teacher solving {len(probs)} problems x {samples}"
                        + (f", thinking budget {think_budget}" if think_budget else ""))

    def generate(jobs):   # [(problem, sample index)] -> [(prompt ids, answer ids, reply text or "")]
        enc = [teacher.encode_chat(prompt(p)) for p, _ in jobs]
        ans = teacher.generate_with_budget(enc, max_tokens, think_budget, pct=(3, 80))
        return [(e, a, teacher.tok.decode(a, skip_special_tokens=True) if teacher.finished(a) else "")
                for e, a in zip(enc, ans)]

    def passes(problem, text) -> bool:
        return bool(text) and run_problem(problem, extract_code(text))["passed"]   # unfinished answers are ""

    jobs = [(p, i) for p in probs for i in range(samples)]
    outs = generate(jobs)
    with ThreadPoolExecutor(max(1, (os.cpu_count() or 4) - 1)) as ex:
        ok = list(ex.map(lambda a: passes(a[0][0], a[1][2]), zip(jobs, outs)))
    job.emit(pct=95, msg=f"{sum(ok)}/{len(jobs)} answers passed their tests")
    passing: dict[int, list] = {}                       # problem -> its passing (prompt, answer) pairs
    for (p, _), (e, a, _), good in zip(jobs, outs, ok):
        if good:
            passing.setdefault(id(p), []).append((e, a))
    if keep == "shortest":                              # the rule: the briefest answer that is right
        chosen = [min(v, key=lambda x: len(x[1])) for v in passing.values()]
    elif keep == "all":
        chosen = [x for v in passing.values() for x in v]
    else:
        raise ValueError(f"keep must be shortest or all, not {keep!r} (fork traces for another rule)")
    rows = [{"ids": list(e) + list(a), "start": len(e)} for e, a in chosen]
    if not rows:
        raise RuntimeError("the teacher solved none of the problems: nothing to train on")
    random.Random(0).shuffle(rows)
    mean = lambda v: round(sum(v) / len(v), 1) if v else 0.0  # noqa: E731
    lens_pass = [len(a) for v in passing.values() for _, a in v]
    stats = {"problems": len(probs), "samples": samples, "answers": len(jobs), "passed": sum(ok),
             "solved": len(passing), "solve_rate": round(len(passing) / max(1, len(probs)), 4), "rows": len(rows),
             "keep": keep, "think_budget": think_budget, "tokens_mean_all": mean([len(o[1]) for o in outs]),
             "tokens_mean_passing": mean(lens_pass), "tokens_mean_kept": mean([len(a) for _, a in chosen])}
    write_jsonl(job.path("work", "heal_data.jsonl"), rows)
    job.path("work", "heal_data_meta.json").unlink(missing_ok=True)   # distil trains on these rows as they are
    job.write("work/heal_traces.json", stats)
    # tell the pipeline's heal these rows are verified traces, so it trains on them instead of
    # asking the teacher again (it regenerates when it thinks it has too few plain answers)
    job.set(heal_calib="contest", heal_samples=samples, heal_prompts=len(probs) if samples > 1 else len(rows))
    teacher.free()
    return {k: v for k, v in stats.items() if isinstance(v, (int, float))}
