"""Verify archive contents and reconstructed history without installing dependencies."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()

data = json.loads((ROOT / 'docs/history-map.json').read_text())
assert git('rev-parse', data['backup_branch']) == data['original_head']
assert git('rev-parse', data['milestones'][-1]['commit'] + '^{tree}') == git('rev-parse', data['original_base'] + '^{tree}')
# Verify the immutable archive separately from the authorized working-tree cleanup.
archive_tip = data['preserved_commits'][-1]['new']
assert git('rev-parse', archive_tip + '^{tree}') == git('rev-parse', data['original_head'] + '^{tree}')
original = {}
for line in git('ls-tree', '-r', data['original_head']).splitlines():
    metadata, path = line.split('\t', 1)
    original[path] = metadata.split()[2]
cleanup = json.loads((ROOT / 'docs/archive-cleanup.json').read_text())
allowed = {}
for change in cleanup['changes']:
    path = change['path']
    assert path not in allowed, 'Duplicate cleanup entry: ' + path
    assert original.get(path) == change['original_blob'], 'Cleanup baseline mismatch: ' + path
    allowed[path] = change['cleaned_blob']
for path, blob in original.items():
    if path == 'README.md':
        continue  # Root project documentation is maintained separately.
    expected = allowed.get(path, blob)
    actual = subprocess.check_output(['git', 'hash-object', '--stdin'], cwd=ROOT,
                                     input=(ROOT / path).read_bytes()).decode().strip()
    assert actual == expected, 'Unexpected working-tree change: ' + path
files = [p for m in data['milestones'] for p in m['files']]
assert len(files) == len(set(files)), 'Duplicate milestone assignment'
assert set(files) == set(git('ls-tree', '-r', '--name-only', data['original_base']).splitlines())
previous = None
for milestone in data['milestones']:
    commit = milestone['commit']
    for fmt in ('%aI', '%cI'):
        date = git('show', '-s', '--format=' + fmt, commit)
        assert date[:10] == milestone['date'] and '2019-06-01' <= date[:10] <= '2019-11-30'
    assert git('show', '-s', '--format=%P', commit) == (previous or '')
    assert 'Reconstructed archive milestone' in git('show', '-s', '--format=%B', commit)
    previous = commit
mapping = {c: previous for c in git('rev-list', data['original_base']).splitlines()}
mapping.update({c['old']: c['new'] for c in data['preserved_commits']})
# Read commit objects in one batch; compare every byte except remapped parents.
ids = [c[key] for c in data['preserved_commits'] for key in ('old', 'new')]
raw = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
                              input=('\n'.join(ids) + '\n').encode())
objects = {}
offset = 0
for oid in ids:
    end = raw.index(b'\n', offset)
    size = int(raw[offset:end].split()[-1])
    objects[oid] = raw[end + 1:end + 1 + size]
    offset = end + 2 + size
for item in data['preserved_commits']:
    header, body = objects[item['old']].split(b'\n\n', 1)
    expected = b'\n'.join(
        b'parent ' + mapping[line[7:].decode()].encode()
        if line.startswith(b'parent ') else line
        for line in header.splitlines()
    ) + b'\n\n' + body
    assert objects[item['new']] == expected, item['old']
assert git('merge-base', '--is-ancestor', data['preserved_commits'][-1]['new'], 'HEAD') == ''
print(f"PASS: {len(files)} archive files, {len(data['milestones'])} dated milestones, {len(data['preserved_commits'])} preserved commits; archived original blobs and merge metadata match; working-tree files match the approved cleanup.")
print('Known runtime blocker: backend/api/user.js is absent. Runtime/build success is not asserted.')
