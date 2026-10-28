"""Model open errors: Hugging Face's 401 page becomes one line that says what to do."""
from blackhole_dev.rpc import open_error

HF_401 = ("401 Client Error. (Request ID: Root=1-6ae20043-332290c94d5ce789084004e4) Repository Not Found for url: "
          "https://huggingface.co/recursive-si/flint-40b/resolve/main/config.json. Please make sure you specified "
          "the correct `repo_id` and `repo_type`. If you are trying to access a private or gated repo, make sure you "
          "are authenticated and your token has the required permissions. For more details, see "
          "https://huggingface.co/docs/huggingface_hub/authentication\nInvalid username or password.")


class RepositoryNotFoundError(OSError):
    pass


class GatedRepoError(OSError):
    pass


def test_hub_401_is_one_actionable_line():
    msg = open_error("recursive-si/flint-40b", RepositoryNotFoundError(HF_401))
    assert msg.startswith("cannot open recursive-si/flint-40b: this repo is gated or private")
    assert "Hugging Face token in Settings" in msg
    assert "\n" not in msg and "Request ID" not in msg and "https://" not in msg


def test_gated_by_type_name():
    assert "gated or private" in open_error("RecursiveSI/flint", GatedRepoError("whatever"))


def test_plain_http_error_text_is_recognised():
    assert "gated or private" in open_error("org/x", OSError("403 Client Error: Forbidden for url"))


def test_local_errors_pass_through():
    assert open_error("/m", FileNotFoundError("no config.json in /m")) == "cannot open /m: no config.json in /m"
    assert open_error("x", ValueError("bad")) == "cannot open x: ValueError: bad"
