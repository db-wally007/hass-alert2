"""Fork addition (hm): a per-alert timeline.

Alert2 announces on the event bus when an alert turns on, turns off, fires, is acked or
unacked. The fork adds a few announcements of its own (see EVENT_HM_* below) and this
module records all of them per alert, so each alert can show a timeline like:

    Detected     23:41:17   kitchen-clock unavailable (condition true, waiting out delay_on_secs)
    Activated    23:46:17   kitchen-clock (since 2 Oct 21:56)
    Notified     23:46:17   mobile_app_alexs_iphone
    Acked        23:52:03   by Alex
    Resolved     08:10:44

The log is kept in its own store rather than read back from the recorder: entries carry
what the bus event carried (the message at that moment, who acked), and the recorder only
keeps state changes. Entries older than RETENTION_DAYS are dropped, matching the recorder's
default purge, and each alert keeps at most MAX_PER_ALERT entries.

While a condition alert is on, what it says can change without it turning off and on: a
second device goes offline, one comes back while others are still out. Its live message
(display_msg) is followed while it is on, a line per item, and an item that appears or goes
is recorded ("changed", with `added` / `removed`). What it last said is kept (stored, so a
restart or an edit of the rule does not lose it) and compared again when the following
resumes - a change while Home Assistant was down is recorded when it is back; an alert never
followed before is compared with what it said when it activated. Items are told apart by name - what comes
before " · " or a closing "(...)", without a trailing value - so a battery going from 15% to
14%, or "Tomorrow" becoming "Today", is not a change.

Following starts only once alerts may judge (start_delay_secs after Home Assistant started):
what a message reads while integrations are still loading is not a change.

Home Assistant's restarts are kept too - when it stopped and when it started again - for the
cards to show in each alert's timeline and history.

A rule's life is in its timeline too: "created", "edited" and "deleted" entries (who, and the
rule's name then). Nothing is dropped - the cards show an alert's timeline from its last edit,
the history everything - and nothing from before an edit is filled back in. A deleted rule's
timeline stays until it ages out.

An alert that comes back already firing (restored at a restart, or recreated) announces
nothing, so a timeline lost with its old entity would stay empty. When an alert is created,
the timeline is filled from what the alert itself remembers: its last activation (or fire)
and its last acknowledgement, if the log has no entry for them (backfill()).

Read it over the websocket: {"type": "alert2/hm/timeline", "entity_id": "alert2.x"} for one
alert, or without entity_id for every alert (the history view). Follow it live with
{"type": "alert2/hm/timeline/subscribe"}: each entry is pushed once it is recorded -
{"entity_id", "entry"} - and an alert whose log changed as a whole (filled in when it was
created, dropped when its rule was deleted) comes as {"entity_id", "entries"}. Recording
waits for the user lookup, so it lands a moment after the alert's state change: a card that
re-read the log on the state change alone could miss the entry it was waiting for.
"""

from __future__ import annotations

import html
import logging
import re
from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import TrackTemplate, async_track_template_result
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .util import (
    DOMAIN,
    EVENT_ALERT2_ACK,
    EVENT_ALERT2_CREATE,
    EVENT_ALERT2_DELETE,
    EVENT_ALERT2_FIRE,
    EVENT_ALERT2_OFF,
    EVENT_ALERT2_ON,
    EVENT_ALERT2_UNACK,
)

_LOGGER = logging.getLogger(__name__)

# Fired by the fork from inside the alert entities (entities.py, marked "hm:").
EVENT_HM_DETECTED = "alert2_hm_detected"            # condition true, delay running
EVENT_HM_DETECT_CLEARED = "alert2_hm_detect_cleared"  # condition went false before the delay ran out
EVENT_HM_NOTIFIED = "alert2_hm_notified"            # notification sent, to whom
EVENT_HM_NOTIFICATION_CONTROL = "alert2_hm_notification_control"  # snooze / disable / enable
EVENT_HM_ACTION = "alert2_hm_action"                # actions_on finished, ok or error

STORAGE_KEY = "alert2.hm_timeline"
STORAGE_VERSION = 1
SAVE_DELAY_SECS = 10
RETENTION_DAYS = 10
MAX_PER_ALERT = 500

# bus event -> timeline kind
_KINDS = {
    EVENT_ALERT2_ON: "on",
    EVENT_ALERT2_OFF: "off",
    EVENT_ALERT2_FIRE: "fire",
    EVENT_ALERT2_ACK: "ack",
    EVENT_ALERT2_UNACK: "unack",
    EVENT_HM_DETECTED: "detected",
    EVENT_HM_DETECT_CLEARED: "detect_cleared",
    EVENT_HM_NOTIFIED: "notified",
    EVENT_HM_NOTIFICATION_CONTROL: "notification_control",
    EVENT_HM_ACTION: "action",
}
# event data copied into the entry when present
# ("names": the notifiers as people read them - an app's by its device's name)
_FIELDS = ("message", "notifiers", "names", "reason", "delay_secs", "enabled", "snooze_until", "ok", "error")

# an item of a message, by name: before " · ", without a closing "(...)" or a trailing value
_TAIL_PAREN = re.compile(r"\s*\([^()]*\)\s*$")
_TAIL_VALUE = re.compile(r"\s+[-+]?\d+(?:[.,]\d+)?\s*(?:%|[^\s\d]{1,6})?\s*$")


def item_key(line: str) -> str:
    """What an item of a message is, whatever it says about it now."""
    key = line.split(" · ", 1)[0]
    key = _TAIL_PAREN.sub("", key)
    key = _TAIL_VALUE.sub("", key)
    return key.strip().lower() or line.strip().lower()


def message_items(text: str) -> dict[str, str]:
    """A message's items, a line each, by name."""
    lines = [ln.strip() for ln in str(text or "").split("\n") if ln.strip()]
    return {item_key(ln): ln for ln in lines}


class TimelineMgr:
    """Records alert bus events per alert and serves them over the websocket."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._alerts: dict[str, list[dict[str, Any]]] = {}
        self._unsubs: list = []
        self._started_unsub = None
        # firing condition alerts whose message is followed: entity_id -> (tracker, items)
        self._watched: dict[str, dict[str, Any]] = {}
        # what each firing alert last said, a line per item (stored with the timeline)
        self._seen: dict[str, list[str]] = {}
        # alerts may judge (start_delay_secs is over); alerts to follow from then
        self._live = False
        self._pending: set[str] = set()
        # Home Assistant's restarts: [{"stopped": iso | None, "started": iso}], and when it
        # last stopped (written at the stop, read at the next start)
        self._restarts: list[dict[str, Any]] = []
        self._stopped: str | None = None
        # live followers (alert2/hm/timeline/subscribe): called with each change
        self._subs: set = set()

    async def async_start(self) -> None:
        data = await self._store.async_load()
        if isinstance(data, dict) and isinstance(data.get("alerts"), dict):
            self._alerts = data["alerts"]
        if isinstance(data, dict) and isinstance(data.get("seen"), dict):
            self._seen = data["seen"]
        if isinstance(data, dict) and isinstance(data.get("restarts"), list):
            self._restarts = data["restarts"]
        if isinstance(data, dict) and isinstance(data.get("stopped"), str):
            self._stopped = data["stopped"]
        self._prune()
        for event_type in _KINDS:
            self._unsubs.append(self.hass.bus.async_listen(event_type, self._async_on_event))
        self._unsubs.append(self.hass.bus.async_listen(EVENT_ALERT2_CREATE, self._async_on_create))
        # follow what a firing alert says, from on to off; a deleted (or replaced) alert stops
        self._unsubs.append(self.hass.bus.async_listen(EVENT_ALERT2_ON, self._on_alert_on))
        self._unsubs.append(self.hass.bus.async_listen(EVENT_ALERT2_OFF, self._on_alert_gone))
        self._unsubs.append(self.hass.bus.async_listen(EVENT_ALERT2_DELETE, self._on_alert_gone))
        # a one-time listener removes itself when it fires: kept apart, so shutdown does not
        # remove it a second time
        self._started_unsub = self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, self._on_ha_started)
        websocket_api.async_register_command(self.hass, self._ws_timeline)
        websocket_api.async_register_command(self.hass, self._ws_subscribe)
        websocket_api.async_register_command(self.hass, self._ws_forget)

    def shutdown(self) -> None:
        # Home Assistant stopping: noted for the restart log (a delayed save is written at the
        # final write)
        self._stopped = dt_util.utcnow().isoformat()
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
        for unsub in self._unsubs:
            unsub()
        self._unsubs = []
        if self._started_unsub:
            self._started_unsub()
            self._started_unsub = None
        for entity_id in list(self._watched):
            self._unwatch(entity_id)

    async def _async_on_event(self, event: Event) -> None:
        entity_id = event.data.get("entity_id")
        if not entity_id:
            return
        entry: dict[str, Any] = {
            "t": event.time_fired.isoformat(),
            "kind": _KINDS[event.event_type],
        }
        for field in _FIELDS:
            if field in event.data and event.data[field] is not None:
                entry[field] = event.data[field]
        if entry["kind"] in ("on", "fire") and "message" not in entry:
            # Alert2's own on/fire events carry no message (and the fork leaves their payload
            # alone); the alert writes the message to its state just before announcing.
            state = self.hass.states.get(entity_id)
            message = state.attributes.get("last_fired_message") if state else None
            if message:
                entry["message"] = message
        user_id = event.context.user_id if event.context else None
        if user_id:
            user = await self.hass.auth.async_get_user(user_id)
            entry["user"] = user.name if user else user_id
        self._append(entity_id, entry)

    def _append(self, entity_id: str, entry: dict[str, Any]) -> None:
        log = self._alerts.setdefault(entity_id, [])
        log.append(entry)
        if len(log) > MAX_PER_ALERT:
            del log[: len(log) - MAX_PER_ALERT]
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
        self._push({"entity_id": entity_id, "entry": entry})

    # ---- Home Assistant's restarts

    @callback
    def _on_ha_started(self, _event: Event) -> None:
        """A start: when it stopped before (unknown after a crash) and when it is back."""
        self._started_unsub = None
        self._restarts.append({"stopped": self._stopped, "started": dt_util.utcnow().isoformat()})
        self._stopped = None
        self._prune()
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
        self._push({"restarts": list(self._restarts)})

    def restarts(self) -> list[dict[str, Any]]:
        return list(self._restarts)

    @callback
    def go_live(self) -> None:
        """Alerts may judge now (start_delay_secs is over): follow what the firing ones say,
        catching up with what they said before."""
        self._live = True
        pending, self._pending = self._pending, set()
        for entity_id in pending:
            self._watch(entity_id, resume=True)

    # ---- what a firing alert says, followed

    @callback
    def _on_alert_on(self, event: Event) -> None:
        if not self._live:
            self._pending.add(event.data.get("entity_id"))
            return
        self._watch(event.data.get("entity_id"))

    @callback
    def _on_alert_gone(self, event: Event) -> None:
        entity_id = event.data.get("entity_id")
        self._pending.discard(entity_id)
        self._unwatch(entity_id)
        # resolved: the next activation starts afresh. (A delete is also an edit's first half:
        # what it said is kept for the alert that replaces it.)
        if event.event_type == EVENT_ALERT2_OFF and self._seen.pop(entity_id, None) is not None:
            self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)

    def _entity(self, entity_id: str):
        data = self.hass.data.get(DOMAIN)
        component = getattr(data, "component", None)
        return component.get_entity(entity_id) if component and entity_id else None

    @callback
    def _watch(self, entity_id: str | None, resume: bool = False) -> None:
        """Follow a condition alert's live message while it is on: its items now are the
        starting point, an item coming or going later is an entry. `resume` (a restart, an
        edit): first compare with what it said before the following stopped."""
        if not entity_id:
            return
        self._unwatch(entity_id)
        state = self.hass.states.get(entity_id)
        ent = self._entity(entity_id)
        tmpl = getattr(ent, "_display_msg_template", None)
        if state is None or state.state != "on" or "last_on_time" not in state.attributes or tmpl is None:
            return
        variables = dict(getattr(ent, "extraVariables", None) or {})
        try:
            first = tmpl.async_render(variables=variables, parse_result=False)
        except Exception:  # an unrenderable message: nothing to compare against
            return
        # what it said before: when it was last followed, or - never followed, and its message
        # written the way its live message is - when it activated
        before = self._seen.get(entity_id) if resume else None
        msg_tmpl = getattr(ent, "_message_template", None)
        if resume and before is None and getattr(msg_tmpl, "template", None) == tmpl.template:
            before = next((html.unescape(str(e["message"])).split("\n") for e in reversed(self._alerts.get(entity_id, []))
                           if e.get("kind") in ("on", "fire") and e.get("message")), None)
        # nothing to compare with yet (None): its first message to say something is the start
        watch: dict[str, Any] = {"items": message_items("\n".join(before)) if before is not None
                                 else (message_items(first) or None)}
        self._compare(entity_id, watch, first)

        @callback
        def changed(event, updates) -> None:
            result = updates[-1].result
            if isinstance(result, Exception):
                return
            self._compare(entity_id, watch, str(result))

        watch["info"] = async_track_template_result(self.hass, [TrackTemplate(tmpl, variables)], changed)
        self._watched[entity_id] = watch

    @callback
    def _unwatch(self, entity_id: str | None) -> None:
        watch = self._watched.pop(entity_id, None) if entity_id else None
        if watch and watch.get("info"):
            watch["info"].async_remove()

    def _compare(self, entity_id: str, watch: dict[str, Any], text: str) -> None:
        items = message_items(text)
        # saying nothing: it is turning off ("Resolved" says so), or what it reads is not there
        # yet (Home Assistant starting) - what it said before stays the thing to compare with
        if not items:
            return
        before = watch["items"]
        watch["items"] = items
        if list(items.values()) != self._seen.get(entity_id):
            self._seen[entity_id] = list(items.values())
            self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
        if before is None:
            return
        added = [line for key, line in items.items() if key not in before]
        removed = [line for key, line in before.items() if key not in items]
        if not added and not removed:
            return
        entry: dict[str, Any] = {"t": dt_util.utcnow().isoformat(), "kind": "changed"}
        if added:
            entry["added"] = added
        if removed:
            entry["removed"] = removed
        self._append(entity_id, entry)

    async def _async_on_create(self, event: Event) -> None:
        entity_id = event.data.get("entity_id")
        state = self.hass.states.get(entity_id) if entity_id else None
        if state is not None and self.backfill(entity_id, state.state, state.attributes):
            self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
            self._push({"entity_id": entity_id, "entries": list(self._alerts.get(entity_id, []))})
        # (re)made already on - a restart, an edit: follow what it says from here, catching up
        # (at a start: once alerts may judge)
        if state is not None and state.state == "on":
            if self._live:
                self._watch(entity_id, resume=True)
            else:
                self._pending.add(entity_id)

    def backfill(self, entity_id: str, state: str, attrs: Any) -> bool:
        """Add the alert's remembered activation / fire and acknowledgement when the log
        lacks them. Returns True when something was added."""
        cutoff = dt_util.utcnow() - timedelta(days=RETENTION_DAYS)
        log = self._alerts.get(entity_id, [])

        def when(name: str):
            val = attrs.get(name)
            if isinstance(val, str):
                val = dt_util.parse_datetime(val)
            return dt_util.as_utc(val) if val else None

        def missing(kind: str, at) -> bool:
            # the bus event is fired a moment after the alert notes the time
            since = (at - timedelta(seconds=5)).isoformat()
            return not any(e.get("kind") == kind and e.get("t", "") >= since for e in log)

        added: list[dict[str, Any]] = []
        # nothing from before an edit of its rule: the timeline started over there
        edited = max((e.get("t", "") for e in log if e.get("kind") == "edited"), default="")

        def after_edit(at) -> bool:
            return not edited or at.isoformat() > edited

        is_condition = "last_on_time" in attrs
        start_kind = "on" if is_condition else "fire"
        start = when("last_on_time") if is_condition else when("last_fired_time")
        if start and start >= cutoff and after_edit(start) and (state == "on" or not is_condition) and missing(start_kind, start):
            entry: dict[str, Any] = {"t": start.isoformat(), "kind": start_kind, "restored": True}
            if attrs.get("last_fired_message"):
                entry["message"] = attrs["last_fired_message"]
            added.append(entry)
        acked = when("last_ack_time")
        if attrs.get("is_acked") and acked and acked >= cutoff and after_edit(acked) and missing("ack", acked):
            added.append({"t": acked.isoformat(), "kind": "ack", "restored": True})
        if not added:
            return False
        self._alerts[entity_id] = sorted(log + added, key=lambda e: e.get("t", ""))[-MAX_PER_ALERT:]
        return True

    def _prune(self) -> None:
        cutoff = (dt_util.utcnow() - timedelta(days=RETENTION_DAYS)).isoformat()
        for entity_id in list(self._alerts):
            # ISO strings with the same offset sort chronologically; entries are written in UTC.
            kept = [e for e in self._alerts[entity_id] if e.get("t", "") >= cutoff]
            if kept:
                self._alerts[entity_id] = kept
            else:
                del self._alerts[entity_id]
        self._restarts = [r for r in self._restarts if r.get("started", "") >= cutoff]

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        self._prune()
        return {"alerts": self._alerts, "seen": self._seen, "restarts": self._restarts, "stopped": self._stopped}

    def _life(self, entity_id: str, kind: str, user: str | None, name: str | None) -> None:
        entry: dict[str, Any] = {"t": dt_util.utcnow().isoformat(), "kind": kind}
        if user:
            entry["user"] = user
        if name:
            entry["name"] = name
        self._append(entity_id, entry)

    def created(self, entity_id: str, user: str | None = None, name: str | None = None) -> None:
        self._life(entity_id, "created", user, name)

    def edited(self, entity_id: str, user: str | None = None, name: str | None = None) -> None:
        """Its rule was edited: the alert starts over (it is made anew, with no state carried
        over) - what it says is followed afresh from its next activation."""
        self._unwatch(entity_id)
        self._pending.discard(entity_id)
        self._seen.pop(entity_id, None)
        self._life(entity_id, "edited", user, name)

    def deleted(self, entity_id: str, user: str | None = None, name: str | None = None) -> None:
        self._unwatch(entity_id)
        self._pending.discard(entity_id)
        self._seen.pop(entity_id, None)
        self._life(entity_id, "deleted", user, name)

    def forget(self, entity_id: str) -> None:
        """Drop an alert's timeline - its rule was deleted."""
        self._seen.pop(entity_id, None)
        if self._alerts.pop(entity_id, None) is not None:
            self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
            self._push({"entity_id": entity_id, "entries": []})

    def _push(self, payload: dict[str, Any]) -> None:
        for follower in list(self._subs):
            follower(payload)

    def timeline(self, entity_id: str | None = None) -> dict[str, list[dict[str, Any]]]:
        if entity_id is not None:
            return {entity_id: list(self._alerts.get(entity_id, []))}
        return {eid: list(entries) for eid, entries in self._alerts.items()}

    @callback
    @websocket_api.websocket_command(
        {
            vol.Required("type"): "alert2/hm/timeline",
            vol.Optional("entity_id"): str,
        }
    )
    def _ws_timeline(self, hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
        connection.send_result(msg["id"], {"alerts": self.timeline(msg.get("entity_id")), "restarts": self.restarts()})

    @callback
    @websocket_api.websocket_command({vol.Required("type"): "alert2/hm/timeline/forget", vol.Required("entity_id"): str})
    def _ws_forget(self, hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
        """Drop an alert's whole timeline from the history (a test rule, a mistake). Admins only
        (checked here: require_admin wraps plain functions, not methods)."""
        if not connection.user.is_admin:
            connection.send_error(msg["id"], "unauthorized", "Admins only")
            return
        self._unwatch(msg["entity_id"])
        self._pending.discard(msg["entity_id"])
        self.forget(msg["entity_id"])
        connection.send_result(msg["id"])

    @callback
    @websocket_api.websocket_command({vol.Required("type"): "alert2/hm/timeline/subscribe"})
    def _ws_subscribe(self, hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
        @callback
        def forward(payload: dict[str, Any]) -> None:
            connection.send_message(websocket_api.event_message(msg["id"], payload))

        @callback
        def unsubscribe() -> None:
            self._subs.discard(forward)

        self._subs.add(forward)
        connection.subscriptions[msg["id"]] = unsubscribe
        connection.send_result(msg["id"])
