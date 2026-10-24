"""Extract selected members of MSYS2 .pkg.tar.zst packages.

Usage: py -I rust/tools/extract_msys2_pkg.py <pytools_dir> <out_dir> <member_suffix,...> <pkg.tar.zst> [...]
Only members whose path ends with one of the suffixes are written (flattened into out_dir).
"""
import io
import os
import sys
import tarfile

pytools, out_dir, suffixes = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
sys.path.insert(0, pytools)
import zstandard  # noqa: E402

os.makedirs(out_dir, exist_ok=True)
for package in sys.argv[4:]:
    with open(package, "rb") as handle:
        data = zstandard.ZstdDecompressor().stream_reader(handle).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            if not any(member.name.endswith(suffix) for suffix in suffixes):
                continue
            target = os.path.join(out_dir, os.path.basename(member.name))
            with archive.extractfile(member) as source, open(target, "wb") as sink:
                sink.write(source.read())
            print(f"{os.path.basename(package)}: {member.name} -> {target}")
