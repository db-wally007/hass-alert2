"""Fork addition (hm): pushes to phones, and what is done with them.

A notification sent to the Home Assistant companion app (a `mobile_app_*` notifier) belongs
to its alert:

- It is tagged with the alert's entity id (data.tag). The alert's next push replaces it on
  the phone, and the push can be taken back.
- It carries buttons:
  - Clear, when the alert may be cleared (the cards' rule: allow_clear, otherwise yes for an
    event alert and no for a condition alert);
  - the cards' snooze lengths: Tomorrow Morning (8:00) and One Week;
  - Custom, which opens the alert in the app (the phone's Alerts page, top-level option
    `alerts_page`) with its snooze menu open.
- A tap opens the alert's link, or, without one, the alert in the app.

The push is taken back (the app's clear_notification, by tag) once it is over: the alert is
OK again, cleared, snoozed, or its notifications are switched off. The phones that hold one
are listed in the alert's `pushed_to` attribute (only while there are any), so a restart in
between forgets nothing.

A button pressed on a phone comes back as the app's `mobile_app_notification_action` event.
It is answered with the calls the cards make (alert2.ack, alert2.notification_control), in
the event's context, so the timeline says who pressed it.

A rule pushes to USERS, not to devices: `user:<user id>` in its notifier list is every device
signed in to the Home Assistant app as that user, `user:*` every device with the app. They are
turned into the devices' notifiers each time it notifies, so a user's new phone is in at once,
and a renamed one is not lost (its notifier is named after the device, and changes with it).
"""

from __future__ import annotations

import datetime as rawdt
import logging

import voluptuous as vol

import homeassistant.util.dt as dt
from homeassistant.components import websocket_api
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.util import slugify

_LOGGER = logging.getLogger(__name__)

DOMAIN = 'alert2'
ACTION_EVENT = 'mobile_app_notification_action'
# a button's action: "HM_ALERT2|<what>|<entity id>"
ACTION_PREFIX = 'HM_ALERT2'
# the reasons whose push gets the buttons: the alert fired, still fires, or still waits to be
# cleared. A summary or an "it turned off" push has nothing left to do.
LIVE_REASONS = ('Fire', 'ReminderOn', 'ReminderToAck')
# Tomorrow Morning, as in the cards
MORNING_HOUR = 8
# the companion app's integration
APP_DOMAIN = 'mobile_app'
# a rule's users: "user:<user id>", and everyone with the app
USER_PREFIX = 'user:'
EVERYONE = 'user:*'


def app_devices(hass: HomeAssistant) -> list[dict]:
    """Every device a push can go to - the Home Assistant app on it, notifications allowed - as
    it is now: the user signed in on it, its notifier and its name."""
    registry = dr.async_get(hass)
    out = []
    for entry in hass.config_entries.async_entries(APP_DOMAIN):
        if entry.disabled_by:
            continue
        data = entry.data
        app = data.get('app_data') or {}
        # as the app integration decides it has a notifier (mobile_app.util.supports_push)
        if not (('push_token' in app and 'push_url' in app) or 'push_websocket_channel' in app):
            continue
        name = data.get('device_name') or entry.title
        # the app's entry has its one device
        device = next(iter(dr.async_entries_for_config_entry(registry, entry.entry_id)), None)
        out.append({
            'user': data.get('user_id'),
            # named as the integration names it (notify's legacy services): after the device
            'notifier': slugify(f'{APP_DOMAIN}_{name}'),
            # as Home Assistant shows the device: renamed there, or as the app calls it
            'name': (device.name_by_user or device.name or name) if device else name,
        })
    return out


def expand(hass: HomeAssistant, notifiers: list[str]) -> list[str]:
    """A rule's notifiers, its users ("user:<id>", "user:*") as their devices' notifiers now.
    Any other name is kept as it is; a device reached twice is told once. A user with no
    device to push to adds nothing."""
    if not any(n.startswith(USER_PREFIX) for n in notifiers):
        return notifiers
    devices = app_devices(hass)
    out: list[str] = []
    for notifier in notifiers:
        if notifier.startswith(USER_PREFIX):
            user = notifier[len(USER_PREFIX):]
            names = [d['notifier'] for d in devices if notifier == EVERYONE or d['user'] == user]
        else:
            names = [notifier]
        out.extend(n for n in names if n not in out)
    return out


def notifier_names(hass: HomeAssistant, notifiers: list[str]) -> list[str]:
    """The notifiers as people read them: an app's by its device's name, others as they are."""
    if not any(is_app(n) for n in notifiers):
        return list(notifiers)
    by_notifier = {d['notifier']: d['name'] for d in app_devices(hass)}
    return [by_notifier.get(service_name(n), n) for n in notifiers]


async def push_users(hass: HomeAssistant) -> dict:
    """The rule editor's "Push to" list: the users by name, each with the devices a push to them
    reaches now (none: the editor offers them only once picked, so they can be let go); and how
    many devices there are in all (everyone)."""
    users: dict[str, dict] = {}
    for user in await hass.auth.async_get_users():
        if user.system_generated:
            continue
        login = next((c.data.get('username') for c in user.credentials if c.data.get('username')), None)
        users[user.id] = {'id': user.id, 'name': user.name or login or user.id, 'devices': []}
    devices = app_devices(hass)
    for d in devices:
        if d['user'] in users:
            users[d['user']]['devices'].append({'name': d['name'], 'notifier': d['notifier']})
    return {'users': sorted(users.values(), key=lambda u: u['name'].lower()), 'devices': len(devices)}


@websocket_api.websocket_command({vol.Required('type'): 'alert2/hm/push_users'})
@websocket_api.async_response
async def ws_push_users(hass: HomeAssistant, connection, msg: dict) -> None:
    """For anyone who may edit rules - the users' and devices' names only."""
    connection.send_result(msg['id'], await push_users(hass))


def service_name(notifier: str) -> str:
    """A notifier as the notify service it names ("notify." left off)."""
    return notifier[len('notify.'):] if notifier.startswith('notify.') else notifier


def is_app(notifier: str) -> bool:
    """Whether the notifier is a phone's companion app."""
    return service_name(notifier).startswith('mobile_app_')


def alert_url(page: str, entity_id: str, snooze: bool = False) -> str:
    """The alert in the app: its popup on the phone's Alerts page (and its snooze menu)."""
    url = f'{page}{"&" if "?" in page else "?"}alert={entity_id}'
    return f'{url}&snooze=1' if snooze else url


def push_args(args: dict, *, notifier: str, entity_id: str, reason: str,
              can_clear: bool, page: str | None) -> dict:
    """The notify call's arguments for one notifier: unchanged unless it is a phone's app.
    What `data` already sets (a rule's own tag, url or actions) is left as it is."""
    if not is_app(notifier):
        return args
    data = dict(args.get('data') or {})
    data.setdefault('tag', entity_id)
    if page and 'url' not in data and 'clickAction' not in data:
        data['url'] = data['clickAction'] = alert_url(page, entity_id)
    if reason in LIVE_REASONS and 'actions' not in data:
        actions = []
        if can_clear:
            actions.append({'action': f'{ACTION_PREFIX}|clear|{entity_id}', 'title': 'Clear'})
        actions.append({'action': f'{ACTION_PREFIX}|morning|{entity_id}', 'title': 'Snooze: Tomorrow Morning'})
        actions.append({'action': f'{ACTION_PREFIX}|week|{entity_id}', 'title': 'Snooze: One Week'})
        if page:
            actions.append({'action': 'URI', 'title': 'Snooze: Custom…',
                            'uri': alert_url(page, entity_id, snooze=True)})
        data['actions'] = actions
    return {**args, 'data': data}


async def take_back(hass: HomeAssistant, notifiers: list[str], entity_id: str) -> None:
    """Remove the alert's push from these phones. A phone without it does nothing."""
    for notifier in notifiers:
        name = service_name(notifier)
        if not hass.services.has_service('notify', name):
            continue
        try:
            await hass.services.async_call(
                'notify', name, {'message': 'clear_notification', 'data': {'tag': entity_id}})
        except Exception as ex:  # one phone failing must not keep the others from it
            _LOGGER.warning('%s: could not take the push back from %s: %s', entity_id, name, ex)


def snooze_until(what: str, now: rawdt.datetime | None = None) -> rawdt.datetime:
    """The end of a snooze button's snooze, as the cards reckon it: Tomorrow Morning is 8:00
    tomorrow, local time; One Week is a week from now."""
    now = now or dt.now()
    if what == 'morning':
        day = (now + rawdt.timedelta(days=1)).date()
        return rawdt.datetime(day.year, day.month, day.day, MORNING_HOUR, 0, tzinfo=dt.get_default_time_zone())
    return now + rawdt.timedelta(days=7)


async def handle_action(hass: HomeAssistant, event: Event) -> None:
    """A button pressed on a push: Clear, or a snooze. Other apps' buttons are left alone."""
    parts = str(event.data.get('action') or '').split('|')
    if len(parts) != 3 or parts[0] != ACTION_PREFIX:
        return
    _, what, entity_id = parts
    if not entity_id.startswith(f'{DOMAIN}.') or hass.states.get(entity_id) is None:
        _LOGGER.warning('A push button for %s, which is not an alert (any more)', entity_id)
        return
    if what == 'clear':
        await hass.services.async_call(DOMAIN, 'ack', {'entity_id': entity_id},
                                       blocking=True, context=event.context)
    elif what in ('morning', 'week'):
        # as the cards snooze: notifications only, the alert itself is not cleared
        await hass.services.async_call(DOMAIN, 'notification_control', {
            'entity_id': entity_id, 'enable': True, 'snooze_until': snooze_until(what),
            'ack_at_snooze_start': False}, blocking=True, context=event.context)
