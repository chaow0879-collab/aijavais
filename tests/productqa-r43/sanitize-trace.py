"""Redact disposable session credentials from a Playwright trace before sharing."""
import json
from pathlib import Path
import re
import sys
import zipfile

target = Path(sys.argv[1])
count = 0
private_names = {"cookie", "set-cookie", "authorization", "proxy-authorization", "x-api-key", "aij_session"}


def clean(value):
    global count
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, dict):
        result = {}
        header_name = str(value.get("name", "")).lower()
        for key, item in value.items():
            if (key.lower() in private_names and isinstance(item, str)) or (key == "value" and header_name in private_names):
                result[key] = "[REDACTED]"
                count += 1
            else:
                result[key] = clean(item)
        return result
    if isinstance(value, str):
        value, changes = re.subn(r"aij_session=[^\s;\"'\\]+", "aij_session=[REDACTED]", value)
        count += changes
    return value


staged = target.with_suffix(".redacted.zip")
with zipfile.ZipFile(target) as source, zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED) as output:
    for item in source.infolist():
        data = source.read(item.filename)
        if item.filename.endswith((".trace", ".network")):
            lines = []
            for line in data.decode("utf-8").splitlines():
                lines.append(json.dumps(clean(json.loads(line)), ensure_ascii=False, separators=(",", ":")))
            data = ("\n".join(lines) + "\n").encode("utf-8")
        output.writestr(item, data)
staged.replace(target)
target.with_suffix(".redaction.json").write_text(json.dumps({"trace": target.name, "redacted_fields": count, "note": "Session cookies and authorization header values removed; browser screenshots unmodified."}, indent=2), encoding="utf-8")
print(json.dumps({"trace": target.name, "redacted_fields": count}))
