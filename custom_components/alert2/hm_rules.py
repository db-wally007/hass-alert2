"""Fork addition (hm): alert rules as files, one YAML file per rule.

With `rules_dir:` set in the alert2 YAML config (a folder, relative to the config dir),
every rule made in the UI is a file there too, named after its entity id:

    alerts/rule_mux28zuoe5.yaml   (alert2.rule_mux28zuoe5)

The files are the source of truth for UI rules. At start-up and on alert2.reload the
folder is read back, so a file edited by hand applies on the next reload, and a file
deleted by hand deletes its rule. A save in the UI (create, update, delete) writes or
removes the file at once. The UI store (`.storage/alert2.storage`) still holds every rule,
as upstream, and is brought into line with the folder each time it is read.

The first start with the option set writes out the rules the UI store already holds, so
nothing is lost by turning it on. After that an empty folder means no UI rules. Without
the option nothing changes: the UI store alone keeps the rules.

A rule's values in the UI store are TEXT - the UI sends strings, and prepStrConfigField
parses them. The files are written for people instead: structured fields (rule, trigger,
...) as YAML, "true"/"false" as booleans, multi-line templates as blocks. Reading turns
them back into the UI's text.

Everything here touches the disk: call it in the executor.
"""

from __future__ import annotations

import json
import os
from typing import Any

import yaml

from homeassistant.util import slugify

# Fields the UI keeps as YAML/JSON text (see prepStrConfigField). Written out as YAML
# structure when they hold one; a template or a plain word stays a string.
STRUCTURED = (
    'rule', 'trigger', 'trigger_on', 'trigger_off', 'exception_ignore_regexes', 'actions_on',
    'notifier', 'summary_notifier', 'done_notifier', 'reminder_frequency_mins',
    'throttle_fires_per_mins', 'generator', 'defer_startup_notifications', 'data', 'supersedes',
)
# Read first in a file: what the rule is and what it is for. `rule` (the builder's form,
# long and of no interest to a reader) goes last; everything else in between, in order.
HEAD = ('domain', 'name', 'generator_name', 'friendly_name', 'category', 'description', 'priority',
        'allow_clear', 'link', 'link_mobile')
TAIL = ('rule',)

HEADER = (
    '# Alert rule {title} ({entity_id}).\n'
    '# Written by the Alerts card when the rule is saved there, and read back when Alert2\n'
    '# starts or reloads. Hand edits are fine - reload Alert2 to apply them - but a save in\n'
    '# the card rewrites the whole file, comments included.\n'
)


def rule_key(cfg: dict) -> tuple:
    """What makes two rules the same rule: Alert2's own key."""
    return (cfg.get('generator_name'), cfg.get('domain'), cfg.get('name'))


def file_name(cfg: dict) -> str:
    """The rule's entity id without its domain - alert2.health_x -> health_x.yaml."""
    key = cfg.get('generator_name') or f"{cfg.get('domain', '')}_{cfg.get('name', '')}"
    return f'{slugify(str(key))}.yaml'


def to_file(cfg: dict) -> dict:
    """The UI's text values -> what a person would write."""
    out: dict[str, Any] = {}
    order = [k for k in HEAD if k in cfg]
    order += [k for k in cfg if k not in HEAD and k not in TAIL]
    order += [k for k in TAIL if k in cfg]
    for k in order:
        v = cfg[k]
        if isinstance(v, str):
            low = v.strip().lower()
            if low in ('true', 'false'):
                v = low == 'true'
            elif k in STRUCTURED:
                try:
                    parsed = yaml.safe_load(v)
                except yaml.YAMLError:
                    parsed = None
                if isinstance(parsed, (dict, list)):
                    v = parsed
        out[k] = v
    return out


def from_file(data: dict) -> dict:
    """What a person wrote -> the UI's text values."""
    out = {}
    for k, v in data.items():
        if isinstance(v, bool):
            v = 'true' if v else 'false'
        elif v is None:
            v = 'null'
        elif isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False)
        elif not isinstance(v, str):
            v = str(v)
        out[str(k)] = v
    return out


class _Dumper(yaml.SafeDumper):
    """Multi-line text as a block, everything else plain."""


def _str(dumper, s):
    return dumper.represent_scalar('tag:yaml.org,2002:str', s, style='|' if '\n' in s else None)


_Dumper.add_representer(str, _str)


def render(cfg: dict, entity_id: str) -> str:
    title = cfg.get('friendly_name') or cfg.get('name') or cfg.get('generator_name') or ''
    body = yaml.dump(to_file(cfg), Dumper=_Dumper, sort_keys=False, allow_unicode=True,
                     default_flow_style=False, width=float('inf'))
    return HEADER.format(title=json.dumps(title, ensure_ascii=False), entity_id=entity_id) + body


def read_dir(path: str) -> tuple[list[tuple[str, dict]] | None, list[str]]:
    """Every rule file in the folder, in name order, as (file name, UI config).

    (None, []) when the folder does not exist. A file that is not a rule is left out and
    named in the errors, so one bad edit cannot take the other rules down with it.
    """
    if not os.path.isdir(path):
        return None, []
    rules: list[tuple[str, dict]] = []
    errors: list[str] = []
    seen: dict[tuple, str] = {}
    for fn in sorted(os.listdir(path)):
        if fn.startswith('.') or not fn.endswith(('.yaml', '.yml')):
            continue
        try:
            with open(os.path.join(path, fn), encoding='utf-8') as f:
                data = yaml.safe_load(f)
        except (OSError, yaml.YAMLError) as ex:
            errors.append(f'{fn}: {ex}')
            continue
        if not isinstance(data, dict) or 'domain' not in data or \
           ('name' not in data and 'generator_name' not in data):
            errors.append(f'{fn}: not a rule (it needs at least domain and name)')
            continue
        cfg = from_file(data)
        key = rule_key(cfg)
        if key in seen:
            errors.append(f'{fn}: the same rule as {seen[key]}, left out')
            continue
        seen[key] = fn
        rules.append((fn, cfg))
    return rules, errors


def make_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def write_rule(path: str, fn: str, text: str) -> None:
    """Whole or not at all: a half-written rule must never be what the next start reads."""
    os.makedirs(path, exist_ok=True)
    tmp = os.path.join(path, f'.{fn}.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, os.path.join(path, fn))


def remove_rule(path: str, fn: str) -> None:
    try:
        os.remove(os.path.join(path, fn))
    except FileNotFoundError:
        pass
