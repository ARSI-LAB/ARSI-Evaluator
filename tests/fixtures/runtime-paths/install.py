"""Install an offline wheel with deep paths and a real console entry point."""
import csv
import io
from pathlib import Path
import subprocess
import sys
import venv
import zipfile

root = Path(sys.argv[1])
package = "evaluator_path_probe"
layers = ["nested_dependency"] * 4
metadata = f"{package}-1.0.dist-info"
files = {
    f"{package}/__init__.py": (
        "from pathlib import Path\n"
        "def main():\n"
        f"    value = Path(__file__).parent.joinpath(*{layers!r}, 'payload.txt').read_text()\n"
        "    assert value == 'installed at final path'\n"
        "    print(value)\n"
    ),
    "/".join([package, *layers, "payload.txt"]): "installed at final path",
    f"{metadata}/METADATA": "Metadata-Version: 2.1\nName: evaluator-path-probe\nVersion: 1.0\n",
    f"{metadata}/WHEEL": "Wheel-Version: 1.0\nGenerator: evaluator-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    f"{metadata}/entry_points.txt": "[console_scripts]\npath-probe = evaluator_path_probe:main\n",
}
record = io.StringIO(newline="")
writer = csv.writer(record)
for name, content in files.items():
    writer.writerow([name, "", len(content.encode("utf-8"))])
writer.writerow([f"{metadata}/RECORD", "", ""])
files[f"{metadata}/RECORD"] = record.getvalue()
wheel = root / f"{package}-1.0-py3-none-any.whl"
with zipfile.ZipFile(wheel, "w") as archive:
    for name, content in files.items():
        archive.writestr(name, content)

environment = root / "venv"
venv.EnvBuilder(with_pip=False).create(environment)
python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
subprocess.run([str(python), "-m", "ensurepip", "--upgrade", "--default-pip"], check=True)
subprocess.run([
    str(python), "-m", "pip", "install", "--no-index", "--no-deps",
    "--disable-pip-version-check", "--no-cache-dir", str(wheel),
], check=True)
