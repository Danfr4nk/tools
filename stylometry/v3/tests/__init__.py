"""Test package. Redirects the v3 data root to a temp dir BEFORE v3 imports."""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="stylo-v3-test-")
os.environ["STYLO_V3_DATA"] = _TMP
