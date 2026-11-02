"""Fork addition (hm): calendar reminders - alerts on calendar events, made for other cards.

The Simple Schedule card's event form has an Alert section. That card does not know how an
Alert2 rule is written: it speaks only this API, and the rule is made here, the way the
Alerts card's editor makes a "When it happens -> a calendar event starts in N min" alert,
let through only for the one event it is about:

  - a one-off event:              trigger.calendar_event.uid == its uid
  - one occurrence of a series:   the uid, and its recurrence_id
  - every occurrence of a series: the uid
  - every event with a title:     the summary, trimmed and in any case ("PrB" == " prb")

Home Assistant hands every calendar trigger the event's uid, recurrence_id and summary
(CalendarEvent.as_dict()), whatever the calendar, so an event the card will not edit (a
locked one, another system's) can have reminders like any other. A title is how events that
are not one series belong together - a timetable mirror makes each lesson an event of its own,
and "every PrB" is the only thing linking them.

A reminder is an ordinary UI rule. It shows in the Alerts view and opens in its editor, whose
calendar trigger knows the filter (the trigger in the rule's form carries `event`). That is
also all that makes a rule a reminder - one calendar trigger with an event - so a reminder
changed in the Alerts view is still the calendar's. A save from the calendar changes only
what the calendar decides (when, who, priority, the event); the rest of a rule set in the
Alerts view (links, actions, Can be cleared, its category) is kept.

Websocket commands, for anyone signed in (as /api/alert2/manageAlert):
  alert2/hm/reminders/targets    who a reminder can push to, and the dashboards for banners
  alert2/hm/reminders/subscribe  every reminder now, then again after each change
  alert2/hm/reminders/save       make one, or change one (ui_id)
  alert2/hm/reminders/delete     by ui_id, or every reminder of an event or an occurrence

A reminder stays Firing until its event starts (at least MIN_STAY_MINS), then turns OK.

A reminder goes once its event has: a sweep (SWEEP_AFTER_START_SECS after Home Assistant
starts, then nightly) removes each reminder whose calendar no longer has its event from a day
ago on - it is over, or it was deleted. A calendar that cannot be read removes nothing, and
a reminder saved in the last hour is left alone (its calendar may not have caught up yet).
A reminder by title is about every event so called, now and later: the sweep never removes
it, nor does deleting one of those events.
"""

from __future__ import annotations

import datetime as rawdt
import json
import logging
import random
import re
import time
from types import SimpleNamespace
from typing import Any

import voluptuous as vol
import yaml

import homeassistant.util.dt as dt_util
from homeassistant.components import websocket_api
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_time_change

from . import hm_push
from .entities import getPreferredEntityId
from .util import create_task

_LOGGER = logging.getLogger(__name__)

DOMAIN = 'alert2'
# a reminder's rule: alert2.rule_<generated id>, like a rule made in the Alerts editor
RULE_DOMAIN = 'rule'
CATEGORY = 'reminders'
MATCHES = ('event', 'series', 'title')
# what a calendar save decides; anything else a rule has (set in the Alerts view) is kept
OWNED = ('friendly_name', 'priority', 'trigger', 'condition', 'message', 'description',
         'stays_firing_mins', 'notifier', 'title', 'annotate_messages', 'overlay',
         # a rule turned into a reminder is an event alert: none of a condition alert's
         'display_msg', 'delay_on_secs', 'threshold')
# Firing until the event starts - but long enough to be seen when it says "at the start"
MIN_STAY_MINS = 15
# the longest "before" a reminder can have: four weeks
MAX_OFFSET_MINS = 4 * 7 * 24 * 60
SWEEP_AFTER_START_SECS = 600
SWEEP_AT = {'hour': 3, 'minute': 17, 'second': 0}
SWEEP_BACK = rawdt.timedelta(days=1)
SWEEP_AHEAD = rawdt.timedelta(days=370)
FRESH_SECS = 3600
# who removed a reminder whose event is over, as its timeline says it
SWEEPER = SimpleNamespace(name='Calendar clean-up')
# "Home page only": a banner on each dashboard's Home view alone, /<dashboard>/home - written as
# the Alerts editor writes it, the page in place of the dashboard in `overlay`
BANNER_HOME = 'home'


# ---- the rule ---------------------------------------------------------------------------

def jstr(s: Any) -> str:
    """A value inside a Jinja expression (the Alerts card's jstr)."""
    return "'" + str(s).replace('\\', '\\\\').replace("'", "\\'") + "'"


def jtext(s: Any) -> str:
    """Plain text in a template, with nothing Jinja could read as a tag (the card's jtext)."""
    return re.sub(r'[{}]', lambda m: "{{ '" + m.group(0) + "' }}", str(s))


def title_key(title: Any) -> str:
    """A title as two are compared: trimmed, any case."""
    return str(title or '').strip().lower()


def event_filter(event: dict) -> str:
    """The trigger's filter: only this event (or these, by title). The Alerts card's
    calEventFilter writes the very same expression - change both together."""
    if event.get('match') == 'title':
        return ("(trigger.calendar_event.summary | default('', true) | trim | lower) == "
                f"{jstr(title_key(event.get('title')))}")
    uid = f"trigger.calendar_event.uid == {jstr(event.get('uid', ''))}"
    if event.get('match') == 'event' and event.get('recurrence_id'):
        return f"{uid} and trigger.calendar_event.recurrence_id == {jstr(event['recurrence_id'])}"
    return uid


def offset_str(mins: int) -> str:
    """A calendar trigger's offset, before the start: "-00:30:00" (at the start "00:00:00")."""
    return f"{'-' if mins else ''}{mins // 60:02d}:{mins % 60:02d}:00"


def offset_text(mins: int) -> str:
    """30 -> "30 min", 90 -> "1 h 30 min", 1440 -> "1 day", 0 -> "" (at the start)."""
    days, rest = divmod(mins, 1440)
    hours, minutes = divmod(rest, 60)
    parts = []
    if days:
        parts.append(f"{days} day{'s' if days > 1 else ''}")
    if hours:
        parts.append(f'{hours} h')
    if minutes:
        parts.append(f'{minutes} min')
    return ' '.join(parts)


def message_tmpl(clock: str) -> str:
    """What it says: "Gymnastics · Today, 6:00 PM" - the Alerts card's calendar message."""
    fmt = '%H:%M' if clock == '24' else '%-I:%M %p'
    return ("{% set ce = trigger.calendar_event %}{% set ts = as_timestamp(ce.start, 0) %}"
            "{% set d = ts | timestamp_custom('%Y-%m-%d') %}{{ ce.summary }} · "
            "{{ ('Today' if d == now().strftime('%Y-%m-%d') else 'Tomorrow' if d == "
            "(now() + timedelta(days=1)).strftime('%Y-%m-%d') else ts | timestamp_custom('%a, %b %-d')) ~ "
            f"('' if ce.all_day else ', ' ~ (ts | timestamp_custom('{fmt}'))) }}}}")


def new_name() -> str:
    """A rule's generated name, as the Alerts editor makes them (base 36 time + 2 random)."""
    n = int(time.time() * 1000)
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out + ''.join(random.choice(digits) for _ in range(2))


def parse_json(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            try:
                return yaml.safe_load(v)
            except yaml.YAMLError:
                return None
    return v


def list_of(v: Any) -> list[str]:
    """A list as a rule keeps it: JSON or YAML text, or one name (the card's listOf)."""
    v = parse_json(v)
    if v is None or v == 'null':
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return [str(v)]


def compile_cfg(hass: HomeAssistant, req: dict, domain: str, name: str, old: dict | None = None) -> dict:
    """The rule for a reminder, as UI text (what the store holds). `old`: the rule it replaces,
    whose fields the calendar does not decide are kept."""
    cal = req['calendar']
    mins = int(req['offset_mins'])
    if req['match'] == 'title':
        # every event so called: no one event's ids, times or date
        named = str(req.get('title') or '').strip()
        event = {'match': 'title', 'title': named, 'uid': None, 'recurrence_id': None,
                 'summary': named, 'start': None, 'all_day': False}
    else:
        event = {
            'match': req['match'],
            'uid': req['uid'],
            'recurrence_id': req.get('recurrence_id') or None,
            'summary': req.get('summary') or '',
            'start': req.get('start') or None,
            'all_day': bool(req.get('all_day')),
        }
    old = old or {}
    old_rule = parse_json(old.get('rule'))
    if not isinstance(old_rule, dict):
        old_rule = {}
    own_msg = old_rule.get('message') or None
    stay = max(mins, MIN_STAY_MINS)
    title = event['summary'].strip() or 'Reminder'

    state = hass.states.get(cal)
    cal_name = (state.attributes.get('friendly_name') if state else None) or cal
    before = f'{offset_text(mins)} before' if mins else 'When it starts:'
    if event['match'] == 'title':
        description = f'{before} every event called "{title}" on {cal_name}'
    else:
        which = 'every occurrence' if event['match'] == 'series' else 'this event'
        description = f'{before} {title} on {cal_name} - {which}'

    cfg = {k: v for k, v in old.items() if k not in OWNED}
    cfg.update({
        'domain': domain,
        'name': name,
        'friendly_name': title,
        'category': old.get('category') or CATEGORY,
        'priority': 'high' if req.get('priority') == 'high' else 'low',
        'trigger': json.dumps([{'trigger': 'calendar', 'event': 'start', 'entity_id': cal,
                                'offset': offset_str(mins), 'id': 't0'}]),
        # as the Alerts editor writes one trigger with a filter and no "Only if"
        'condition': "{{ ((trigger.id == 't0' and (" + event_filter(event) + "))) }}",
        'message': own_msg or message_tmpl(req.get('clock') or '24'),
        'description': description,
        'stays_firing_mins': str(stay),
    })
    cfg.setdefault('allow_clear', 'true')
    rule = dict(old_rule)
    rule.update({
        'v': 1, 'type': 'event',
        'conds': [{'kind': 'tcal', 'trig': True, 'entity': cal, 'mins': mins, 'event': event}],
        'match': 'all', 'stay_mins': stay, 'message': own_msg,
        'actions': old_rule.get('actions') or [],
    })
    cfg['rule'] = json.dumps(rule, ensure_ascii=False)
    # as the Alerts editor's Notify: pushed to users, titled with the alert's name
    push = [str(p) for p in req.get('push') or []]
    banner = [str(b) for b in req.get('banner') or []]
    if push:
        cfg['notifier'] = json.dumps(push)
        cfg['title'] = jtext(title)
        cfg['annotate_messages'] = 'false'
    if banner:
        cfg['overlay'] = json.dumps([f'{b}/{BANNER_HOME}' for b in banner] if req.get('banner_home') else banner)
    return cfg


def banner_of(overlay: Any) -> tuple[list[str], bool]:
    """A rule's banner places as the dashboards, and whether on their Home pages only (every
    place a Home page - the Alerts editor's "Home page only")."""
    places = list_of(overlay)
    dashboards = list(dict.fromkeys(p.split('/')[0] for p in places))
    return dashboards, bool(places) and all(p.endswith(f'/{BANNER_HOME}') for p in places)


def reminder_of(info: dict) -> dict | None:
    """A UI rule as a reminder, or None when it is not one (one calendar trigger with an event)."""
    cfg = info.get('cfg') or {}
    rule = parse_json(cfg.get('rule'))
    if not isinstance(rule, dict) or rule.get('type') != 'event':
        return None
    trigs = [c for c in rule.get('conds') or [] if isinstance(c, dict) and c.get('trig')]
    if len(trigs) != 1 or trigs[0].get('kind') != 'tcal':
        return None
    c = trigs[0]
    ev = c.get('event')
    if not isinstance(ev, dict) or ev.get('match') not in MATCHES:
        return None
    # by title: a title to match; otherwise: the event's uid
    if not (str(ev.get('title') or '').strip() if ev['match'] == 'title' else ev.get('uid')):
        return None
    try:
        mins = max(0, int(c.get('mins') or 0))
    except (TypeError, ValueError):
        mins = 0
    domain, name = cfg.get('domain', ''), cfg.get('name', '')
    banner, banner_home = banner_of(cfg.get('overlay'))
    return {
        'ui_id': info.get('uiId'),
        'entity_id': getPreferredEntityId(domain, name),
        'name': cfg.get('friendly_name') or name,
        'calendar': c.get('entity') or '',
        'match': ev['match'],
        'uid': ev.get('uid') or None,
        'recurrence_id': ev.get('recurrence_id') or None,
        'title': str(ev.get('title') or '').strip() or None,
        'summary': ev.get('summary') or '',
        'start': ev.get('start') or None,
        'all_day': bool(ev.get('all_day')),
        'offset_mins': mins,
        'push': list_of(cfg.get('notifier')),
        'banner': banner,
        'banner_home': banner_home,
        # two priorities only: the cards read Alert2's medium as high
        'priority': 'low' if str(cfg.get('priority') or 'low') == 'low' else 'high',
    }


def banner_dashboards(hass: HomeAssistant, user) -> list[dict]:
    """The dashboards a banner can show on, as the Alerts card lists them: every dashboard the
    user can see but the map and the hidden built-in one, under their sidebar names."""
    panels = hass.data.get('frontend_panels') or {}
    overrides = hass.data.get('frontend_panels_config') or {}
    out = []
    for key, panel in panels.items():
        try:
            p = panel.to_response(overrides.get(key))
        except Exception:  # an older or newer frontend: leave that one out
            continue
        if p.get('component_name') != 'lovelace' or p.get('url_path') == 'map':
            continue
        if p.get('url_path') == 'lovelace' and p.get('show_in_sidebar') is False:
            continue
        if p.get('require_admin') and not getattr(user, 'is_admin', False):
            continue
        out.append({'id': p['url_path'], 'name': p.get('title') or p['url_path'],
                    'icon': p.get('icon') or 'mdi:view-dashboard'})
    return sorted(out, key=lambda d: d['name'].lower())


# ---- the manager ------------------------------------------------------------------------

class ReminderMgr:
    def __init__(self, hass: HomeAssistant, alert_data) -> None:
        self.hass = hass
        self._ad = alert_data
        self._subs: set = set()
        self._unsubs: list = []
        self._touched: dict[int, float] = {}  # ui_id -> when it was last saved here
        self._sweeping = False

    def start(self) -> None:
        for cmd in (ws_targets, ws_subscribe, ws_save, ws_delete):
            websocket_api.async_register_command(self.hass, cmd)
        self._unsubs.append(async_track_time_change(self.hass, self._sweep_soon, **SWEEP_AT))
        if self.hass.is_running:
            self._unsubs.append(async_call_later(self.hass, SWEEP_AFTER_START_SECS, self._sweep_soon))
        else:
            self._unsubs.append(self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, self._on_started))

    def shutdown(self) -> None:
        for unsub in self._unsubs:
            try:
                unsub()
            except Exception:  # a one-time listener that already ran
                pass
        self._unsubs = []

    @callback
    def _on_started(self, _event=None) -> None:
        self._unsubs.append(async_call_later(self.hass, SWEEP_AFTER_START_SECS, self._sweep_soon))

    @callback
    def _sweep_soon(self, _now=None) -> None:
        create_task(self.hass, DOMAIN, self.sweep())

    def _infos(self) -> list[dict]:
        ui = self._ad.uiMgr
        if not ui or not ui.storeData:
            return []
        return list(ui.storeData.get('alertInfos') or [])

    def reminders(self) -> list[dict]:
        return [r for r in (reminder_of(i) for i in self._infos()) if r]

    @callback
    def changed(self) -> None:
        """A UI rule was made, changed or removed (or the rules were read again)."""
        if not self._subs:
            return
        payload = {'reminders': self.reminders()}
        for follower in list(self._subs):
            follower(payload)

    async def save(self, req: dict, user) -> dict:
        ui = self._ad.uiMgr
        if not ui:
            return {'error': 'Alerting has not started yet'}
        ui_id = req.get('ui_id')
        if ui_id is not None:
            info = next((i for i in self._infos() if i.get('uiId') == ui_id), None)
            if info is None or not reminder_of(info):
                return {'error': 'That reminder is gone'}
            domain, name = info['cfg'].get('domain'), info['cfg'].get('name')
            cfg = compile_cfg(self.hass, req, domain, name, old=info['cfg'])
            rez = await ui.updateAlert(ui_id, cfg, hmUser=user)
        else:
            domain, name = RULE_DOMAIN, new_name()
            cfg = compile_cfg(self.hass, req, domain, name)
            rez = await ui.createAlert(cfg, hmUser=user)
            ui_id = rez.get('uiId')
        if rez.get('error'):
            return {'error': str(rez['error'])}
        self._touched[ui_id] = time.monotonic()
        return {'ui_id': ui_id, 'entity_id': getPreferredEntityId(domain, name)}

    async def delete(self, req: dict, user) -> dict:
        ui = self._ad.uiMgr
        if not ui:
            return {'error': 'Alerting has not started yet'}
        mine = self.reminders()
        if req.get('ui_id') is not None:
            gone = [r for r in mine if r['ui_id'] == req['ui_id']]
        else:
            rid = req.get('recurrence_id')
            # an event deleted: its own reminders, never one by title (the other events so
            # called still have it)
            gone = [r for r in mine if r['match'] != 'title' and r['calendar'] == req.get('calendar')
                    and r['uid'] == req.get('uid') and (not rid or r['recurrence_id'] == rid)]
        deleted, errors = [], []
        for r in gone:
            rez = await ui.deleteAlert(r['ui_id'], hmUser=user)
            if rez.get('error'):
                errors.append(str(rez['error']))
            else:
                deleted.append(r['ui_id'])
                self._touched.pop(r['ui_id'], None)
        out: dict[str, Any] = {'deleted': deleted}
        if errors:
            out['error'] = '; '.join(errors)
        return out

    async def sweep(self) -> list[int]:
        """Remove the reminders whose event is over or gone. The ui_ids removed."""
        if self._sweeping:
            return []
        self._sweeping = True
        try:
            return await self._sweep()
        finally:
            self._sweeping = False

    async def _sweep(self) -> list[int]:
        ui = self._ad.uiMgr
        if not ui:
            return []
        now = dt_util.now()
        fresh = time.monotonic() - FRESH_SECS
        by_cal: dict[str, list[dict]] = {}
        for r in self.reminders():
            # by title: about events still to be made, too - never over
            if r['match'] == 'title' or self._touched.get(r['ui_id'], -1e18) > fresh:
                continue
            by_cal.setdefault(r['calendar'], []).append(r)
        component = self.hass.data.get('calendar')
        removed: list[int] = []
        for cal, rems in by_cal.items():
            entity = component.get_entity(cal) if component else None
            if entity is None:
                continue  # not there (yet): remove nothing on a calendar that cannot be read
            try:
                events = await entity.async_get_events(self.hass, now - SWEEP_BACK, now + SWEEP_AHEAD)
            except Exception as ex:
                _LOGGER.warning(f'reminders: could not read {cal}: {ex}')
                continue
            uids = {e.uid for e in events}
            occurrences = {(e.uid, e.recurrence_id) for e in events}
            for r in rems:
                if r['match'] == 'event' and r['recurrence_id']:
                    alive = (r['uid'], r['recurrence_id']) in occurrences
                else:
                    alive = r['uid'] in uids
                if alive:
                    continue
                rez = await ui.deleteAlert(r['ui_id'], hmUser=SWEEPER)
                if not rez.get('error'):
                    removed.append(r['ui_id'])
                    _LOGGER.info(f'reminders: removed {r["entity_id"]} - its event on {cal} is over or gone')
        return removed


def _mgr(hass: HomeAssistant) -> ReminderMgr | None:
    data = hass.data.get(DOMAIN)
    return getattr(data, 'hmReminders', None)


@websocket_api.websocket_command({vol.Required('type'): 'alert2/hm/reminders/targets'})
@websocket_api.async_response
async def ws_targets(hass: HomeAssistant, connection, msg: dict) -> None:
    """Who a reminder can push to (the Alerts editor's Push to: users with the app, and
    everyone) and where it can show a banner."""
    users = await hm_push.push_users(hass)
    connection.send_result(msg['id'], {
        'users': users['users'],
        'devices': users['devices'],
        'everyone': hm_push.EVERYONE,
        'user_prefix': hm_push.USER_PREFIX,
        'banner': banner_dashboards(hass, connection.user),
    })


@callback
@websocket_api.websocket_command({vol.Required('type'): 'alert2/hm/reminders/subscribe'})
def ws_subscribe(hass: HomeAssistant, connection, msg: dict) -> None:
    mgr = _mgr(hass)
    if mgr is None:
        connection.send_error(msg['id'], 'not_ready', 'Alerting has not started yet')
        return

    @callback
    def forward(payload: dict) -> None:
        connection.send_message(websocket_api.event_message(msg['id'], payload))

    @callback
    def unsubscribe() -> None:
        mgr._subs.discard(forward)

    mgr._subs.add(forward)
    connection.subscriptions[msg['id']] = unsubscribe
    connection.send_result(msg['id'])
    forward({'reminders': mgr.reminders()})


@websocket_api.websocket_command({
    vol.Required('type'): 'alert2/hm/reminders/save',
    vol.Optional('ui_id'): int,
    vol.Required('calendar'): vol.All(str, vol.Match(r'^calendar\.')),
    # one event: its uid; every event so called (match title): the title
    vol.Optional('uid'): vol.Any(None, str),
    vol.Optional('title'): vol.Any(None, str),
    vol.Optional('recurrence_id'): vol.Any(None, str),
    vol.Required('match'): vol.In(MATCHES),
    vol.Optional('summary', default=''): str,
    vol.Optional('start'): vol.Any(None, str),
    vol.Optional('all_day', default=False): bool,
    vol.Required('offset_mins'): vol.All(int, vol.Range(min=0, max=MAX_OFFSET_MINS)),
    vol.Optional('push', default=[]): [str],
    vol.Optional('banner', default=[]): [str],
    # the banner on those dashboards' Home pages only
    vol.Optional('banner_home', default=False): bool,
    vol.Optional('priority', default='low'): vol.In(('low', 'high')),
    vol.Optional('clock', default='24'): vol.In(('12', '24')),
})
@websocket_api.async_response
async def ws_save(hass: HomeAssistant, connection, msg: dict) -> None:
    mgr = _mgr(hass)
    if mgr is None:
        connection.send_error(msg['id'], 'not_ready', 'Alerting has not started yet')
        return
    if msg['match'] == 'title' and not str(msg.get('title') or '').strip():
        connection.send_error(msg['id'], 'invalid', 'A reminder by title needs the title')
        return
    if msg['match'] != 'title' and not msg.get('uid'):
        connection.send_error(msg['id'], 'invalid', 'A reminder of one event needs its uid')
        return
    rez = await mgr.save(msg, connection.user)
    if rez.get('error'):
        connection.send_error(msg['id'], 'invalid', rez['error'])
    else:
        connection.send_result(msg['id'], rez)


@websocket_api.websocket_command({
    vol.Required('type'): 'alert2/hm/reminders/delete',
    vol.Exclusive('ui_id', 'which'): int,
    vol.Exclusive('uid', 'which'): vol.All(str, vol.Length(min=1)),
    vol.Optional('calendar'): str,
    vol.Optional('recurrence_id'): vol.Any(None, str),
})
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection, msg: dict) -> None:
    mgr = _mgr(hass)
    if mgr is None:
        connection.send_error(msg['id'], 'not_ready', 'Alerting has not started yet')
        return
    if msg.get('ui_id') is None and not (msg.get('uid') and msg.get('calendar')):
        connection.send_error(msg['id'], 'invalid', 'Say which: ui_id, or calendar and uid')
        return
    rez = await mgr.delete(msg, connection.user)
    if rez.get('error'):
        connection.send_error(msg['id'], 'invalid', rez['error'])
    else:
        connection.send_result(msg['id'], rez)
