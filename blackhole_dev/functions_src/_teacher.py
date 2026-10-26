"""The teacher as job functions use it: tokenizer, sampling settings, end-of-answer tokens and
batched generation (vLLM in its own process when installed, REAPer's fast Flint decoder, or
plain transformers generate). Ported from the pipeline's heal stage so data functions (traces,
your own) can make teacher answers without running a whole heal. A fork may import it or copy it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field


@dataclass
class Teacher:
    job: object
    tok: object = None
    temperature: float = 1.0
    top_p: float = 0.95
    top_k: int = 20
    eos: list = field(default_factory=list)
    think_end: int | None = None       # the </think> token id, when the model thinks
    use_vllm: bool = False
    _model: object = None

    @classmethod
    def of(cls, job) -> "Teacher":
        from reaper_pipeline.load import load_tokenizer

        from blackhole_pipeline import hfmoe
        rj = job.rj
        tok = load_tokenizer(rj.model_dir, rj.config.trust_remote_code)
        try:
            from transformers import GenerationConfig
            gc = GenerationConfig.from_pretrained(rj.model_dir)
        except Exception:  # noqa: BLE001
            gc = None
        sampled = getattr(gc, "do_sample", False)
        ge = getattr(gc, "eos_token_id", None)
        eos = sorted({t for t in [tok.eos_token_id, *(ge if isinstance(ge, list) else [ge])] if t is not None})
        flint = json.loads((rj.model_dir / "config.json").read_text()).get("model_type") == "flint"
        return cls(job, tok, (gc.temperature or 1.0) if sampled else 1.0, (gc.top_p or 0.95) if sampled else 0.95,
                   int((gc.to_diff_dict() if gc is not None else {}).get("top_k") or 20), eos,
                   tok.get_vocab().get("</think>"), not flint and hfmoe.can_vllm())

    def encode_chat(self, messages: list[dict]) -> list[int]:
        text = self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        return self.tok(text, add_special_tokens=False)["input_ids"][:self.job.rj.config.max_seq]

    def finished(self, ids: list[int]) -> bool:
        """Ended on its own (not cut by the token cap) and, for a thinking model, closed its thinking."""
        return bool(ids) and ids[-1] in self.eos and (self.think_end is None or self.think_end in ids)

    def model(self):
        if self._model is None:
            from reaper_pipeline.load import load_model
            from reaper_pipeline.stages._common import profile
            rj = self.job.rj
            self.job.emit(pct=None, msg="loading the teacher")
            m = load_model(rj.model_dir, profile(rj), rj.config.trust_remote_code).eval()
            for q in m.parameters():
                q.requires_grad_(False)
            self._model = m
        return self._model

    def free(self) -> None:
        from reaper_pipeline.load import free
        self._model = None
        free()

    def generate(self, enc: list[list[int]], max_tokens: int, what: str = "answers", pct: tuple = (0, 100),
                 temperature: float | None = None, top_p: float | None = None, top_k: int | None = None) -> list[list]:
        """Answer token ids for every prompt in enc."""
        from blackhole_pipeline import hfmoe
        t = self.temperature if temperature is None else temperature
        p = self.top_p if top_p is None else top_p
        k = self.top_k if top_k is None else top_k
        a, b = pct
        done = [0]
        answers: list = [None] * len(enc)

        def on_done(i, r):
            answers[i] = r
            done[0] += 1
            if done[0] % 16 == 0:
                self.job.emit(pct=a + (b - a) * done[0] / len(enc), msg=f"teacher {what} {done[0]}/{len(enc)}")
        if self.use_vllm:
            def on_line(line):
                if line.startswith("vllm_gen: done"):
                    x, y = line.split()[-1].split("/")
                    self.job.emit(pct=a + (b - a) * int(x) / int(y), msg=f"teacher {what} {x}/{y} (vLLM)")
            return hfmoe.vllm_generate(self.job.rj.model_dir, enc, max_tokens, t, p, k, self.eos, on_line=on_line)
        m = self.model()
        if hasattr(m, "generate_many"):
            from blackhole_pipeline.bench import fit_batch
            slots = fit_batch(m, min(len(enc), 256), max(map(len, enc)) + max_tokens)
            m.generate_many(enc, max_tokens, t, p, self.eos, slots=slots, on_done=on_done, top_k=k)
        else:
            hfmoe.hf_answers(m, self.tok, enc, max_tokens, t, p, k, self.eos, on_done)
        return [x or [] for x in answers]

    def generate_with_budget(self, enc: list[list[int]], max_tokens: int, budget: int, pct: tuple = (0, 100)) -> list:
        """Budget forcing: thinking still open after `budget` tokens is cut there, the teacher is
        told to answer now, and the forced answer is appended."""
        if not budget or self.think_end is None:
            return self.generate(enc, max_tokens, "answers", pct)
        from blackhole_pipeline.bench import ANSWER_TOKENS, FORCE_ANSWER
        a, b = pct
        mid = a + (b - a) * 0.8
        ans = self.generate(enc, budget, "answers", (a, mid))
        force = self.tok(FORCE_ANSWER, add_special_tokens=False)["input_ids"]
        cut = [i for i, x in enumerate(ans) if self.think_end not in x and not (x and x[-1] in self.eos)]
        self.job.emit(pct=mid, msg=f"{len(cut)} answers still thinking at {budget} tokens: told to answer now")
        more = self.generate([enc[i] + ans[i][:budget] + force for i in cut], ANSWER_TOKENS, "forced answers",
                             (mid, b)) if cut else []
        for i, x in zip(cut, more):
            ans[i] = ans[i][:budget] + force + list(x)
        return ans
