#
# Tests for the fork's calendar reminders (hm_reminders.py): an alert on a calendar event,
# made through alert2/hm/reminders/* for the Simple Schedule card. Run like the other tests,
# from a checkout outside the Home Assistant config dir:
#     pytest tests/test_hm_reminders.py
#
import os
import sys
import datetime as rawdt
import json
import pytest

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.components.frontend import Panel
from homeassistant.helpers.template import Template
from homeassistant.setup import async_setup_component
import homeassistant.util.dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockModule, MockPlatform, async_fire_time_changed, mock_integration, mock_platform)

if os.environ.get('JTESTDIR'):
    sys.path.insert(0, os.environ['JTESTDIR'])
from custom_components.alert2 import DOMAIN
import custom_components.alert2 as alert2
import custom_components.alert2.hm_reminders as hm_reminders

alert2.gGcDelaySecs = 0.1


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
async def auto_check_empty_calls(hass, service_calls):
    yield
    await hass.async_block_till_done()
    assert service_calls.isEmpty()


class FakeCalendar(CalendarEntity):
    """A calendar holding a fixed list of events."""

    def __init__(self, events):
        self._attr_name = 'Kids'
        self._attr_unique_id = 'kids'
        self.events = events
        self.fail = False

    @property
    def event(self):
        return None

    async def async_get_events(self, hass, start_date, end_date):
        if self.fail:
            raise RuntimeError('calendar is down')
        return [e for e in self.events
                if e.start_datetime_local < end_date and e.end_datetime_local > start_date]


def ev(summary, start, uid, rid=None, mins=60):
    return CalendarEvent(start=start, end=start + rawdt.timedelta(minutes=mins), summary=summary,
                         uid=uid, recurrence_id=rid)


async def add_calendar(hass, events):
    cal = FakeCalendar(events)

    async def setup_platform(hass, config, async_add_entities, discovery_info=None):
        async_add_entities([cal])

    mock_integration(hass, MockModule('fakecal'))
    mock_platform(hass, 'fakecal.calendar', MockPlatform(async_setup_platform=setup_platform))
    assert await async_setup_component(hass, 'calendar', {'calendar': {'platform': 'fakecal'}})
    await hass.async_block_till_done()
    assert hass.states.get('calendar.kids')
    return cal


async def start(hass):
    # nobody is told anything in these tests: the default notifier is none
    cfg = {'alert2': {'defaults': {'notifier': None}, 'alerts': []}}
    assert await async_setup_component(hass, DOMAIN, cfg)
    await hass.async_start()
    await hass.async_block_till_done()
    return hass.data[DOMAIN]


def req(**kw):
    out = {'calendar': 'calendar.kids', 'uid': 'gym@google.com', 'match': 'series',
           'summary': 'Gymnastics', 'start': '2026-10-21T18:00:00+02:00', 'all_day': False,
           'offset_mins': 30, 'push': [], 'banner': [], 'priority': 'low', 'clock': '24'}
    out.update(kw)
    return out


async def ws(client, n, **msg):
    await client.send_json({'id': n, **msg})
    return await client.receive_json()


def render(hass, tmpl, cal_event):
    return Template(tmpl, hass).async_render({'trigger': {'id': 't0', 'calendar_event': cal_event}})


# ---- the rule ---------------------------------------------------------------------------

async def test_hm_reminders_rule_matches_only_its_event(hass, service_calls):
    await start(hass)
    occ = {'uid': 'gym@google.com', 'recurrence_id': 'gym_20261021T160000Z'}
    other = {'uid': 'gym@google.com', 'recurrence_id': 'gym_20261028T160000Z'}
    stranger = {'uid': 'cook@google.com', 'recurrence_id': None}
    series = hm_reminders.compile_cfg(hass, req(), 'rule', 'x1')
    one = hm_reminders.compile_cfg(hass, req(match='event', recurrence_id=occ['recurrence_id']), 'rule', 'x2')
    single = hm_reminders.compile_cfg(hass, req(match='event', uid='cook@google.com'), 'rule', 'x3')
    assert json.loads(series['trigger']) == [{'trigger': 'calendar', 'event': 'start', 'entity_id': 'calendar.kids',
                                              'offset': '-00:30:00', 'id': 't0'}]
    assert render(hass, series['condition'], occ) is True
    assert render(hass, series['condition'], other) is True
    assert render(hass, series['condition'], stranger) is False
    assert render(hass, one['condition'], occ) is True
    assert render(hass, one['condition'], other) is False
    assert render(hass, single['condition'], stranger) is True
    assert render(hass, single['condition'], occ) is False
    # Firing until the event starts, at least a quarter of an hour
    assert series['stays_firing_mins'] == '30'
    assert hm_reminders.compile_cfg(hass, req(offset_mins=0), 'rule', 'x')['stays_firing_mins'] == '15'
    assert hm_reminders.offset_str(0) == '00:00:00'
    assert hm_reminders.offset_str(10080) == '-168:00:00'
    # a quote in a uid cannot break out of the expression
    odd = hm_reminders.compile_cfg(hass, req(uid="it's"), 'rule', 'x')
    assert render(hass, odd['condition'], {'uid': "it's", 'recurrence_id': None}) is True
    # by title: every event so called, whatever its ids - trimmed, any case
    named = hm_reminders.compile_cfg(hass, req(match='title', uid=None, title=' PrB '), 'rule', 'x4')
    assert render(hass, named['condition'], {'uid': 'a@google.com', 'summary': 'PrB'}) is True
    assert render(hass, named['condition'], {'uid': 'b@google.com', 'summary': ' prb'}) is True
    assert render(hass, named['condition'], {'uid': 'c@google.com', 'summary': 'PrB 2'}) is False
    assert render(hass, named['condition'], {'uid': 'd@google.com', 'summary': None}) is False
    assert named['friendly_name'] == 'PrB'
    assert 'every event called "PrB"' in named['description']
    ev_ = json.loads(named['rule'])['conds'][0]['event']
    assert ev_['match'] == 'title' and ev_['title'] == 'PrB' and ev_['uid'] is None
    quoted = hm_reminders.compile_cfg(hass, req(match='title', title="Mum's {{ day }}"), 'rule', 'x5')
    assert render(hass, quoted['condition'], {'summary': "mum's {{ day }}"}) is True
    # the Alerts editor reads it as its own: one calendar trigger carrying the event
    rule = json.loads(series['rule'])
    assert rule['type'] == 'event' and rule['conds'][0]['kind'] == 'tcal' and rule['conds'][0]['mins'] == 30
    assert rule['conds'][0]['event']['uid'] == 'gym@google.com'


async def test_hm_reminders_save_keeps_what_the_calendar_does_not_decide(hass, service_calls, hass_ws_client):
    await add_calendar(hass, [])
    gad = await start(hass)
    client = await hass_ws_client(hass)
    msg = await ws(client, 1, type='alert2/hm/reminders/save', **req(push=['user:abc'], banner=['tablet-dashboard']))
    assert msg['success'], msg
    ui_id, eid = msg['result']['ui_id'], msg['result']['entity_id']
    assert eid.startswith('alert2.rule_')
    await hass.async_block_till_done()
    st = hass.states.get(eid)
    assert st and st.attributes['friendly_name'] == 'Gymnastics'
    assert st.attributes['category'] == 'reminders'
    cfg = gad.uiMgr.loadAlert(ui_id)
    assert json.loads(cfg['notifier']) == ['user:abc'] and cfg['annotate_messages'] == 'false'
    assert json.loads(cfg['overlay']) == ['tablet-dashboard']
    # Home page only: the Home pages in place of the dashboards, and read back as the dashboards
    msg = await ws(client, 2, type='alert2/hm/reminders/save', ui_id=ui_id,
                   **req(push=['user:abc'], banner=['tablet-dashboard', 'dashboard-clock'], banner_home=True))
    assert msg['success'], msg
    cfg = gad.uiMgr.loadAlert(ui_id)
    assert json.loads(cfg['overlay']) == ['tablet-dashboard/home', 'dashboard-clock/home']
    mine = [r for r in gad.hmReminders.reminders() if r['ui_id'] == ui_id][0]
    assert mine['banner'] == ['tablet-dashboard', 'dashboard-clock'] and mine['banner_home'] is True
    assert hm_reminders.banner_of('["tablet-dashboard"]') == (['tablet-dashboard'], False)
    assert hm_reminders.banner_of(None) == ([], False)
    # set in the Alerts view: a link, and no clearing
    rez = await gad.uiMgr.updateAlert(ui_id, dict(cfg, link='/x', allow_clear='false'))
    assert 'error' not in rez, rez
    # the calendar changes when and who; the rest stays
    msg = await ws(client, 3, type='alert2/hm/reminders/save', ui_id=ui_id, **req(offset_mins=60, priority='high'))
    assert msg['success'], msg
    assert msg['result']['entity_id'] == eid
    cfg = gad.uiMgr.loadAlert(ui_id)
    assert cfg['link'] == '/x' and cfg['allow_clear'] == 'false'
    assert cfg['priority'] == 'high' and cfg['stays_firing_mins'] == '60'
    assert 'notifier' not in cfg and 'overlay' not in cfg   # nobody now
    # a rule that is not a reminder is not this API's to change
    other = await gad.uiMgr.createAlert({'domain': 'test', 'name': 'plain', 'condition': 'off'})
    msg = await ws(client, 4, type='alert2/hm/reminders/save', ui_id=other['uiId'], **req())
    assert not msg['success']
    msg = await ws(client, 5, type='alert2/hm/reminders/delete', ui_id=other['uiId'])
    assert msg['success'] and msg['result']['deleted'] == []
    assert gad.uiMgr.loadAlert(other['uiId']).get('name') == 'plain'


async def test_hm_reminders_subscribe_and_delete(hass, service_calls, hass_ws_client):
    await add_calendar(hass, [])
    gad = await start(hass)
    client = await hass_ws_client(hass)
    await client.send_json({'id': 1, 'type': 'alert2/hm/reminders/subscribe'})
    assert (await client.receive_json())['success']
    assert (await client.receive_json())['event'] == {'reminders': []}

    occ = 'gym_20261021T160000Z'
    # the followers hear of it as it is made, before the save answers
    await client.send_json({'id': 2, 'type': 'alert2/hm/reminders/save', **req()})
    msgs = [await client.receive_json(), await client.receive_json()]
    series_id = next(m for m in msgs if m['id'] == 2)['result']['ui_id']
    pushed = next(m for m in msgs if m['id'] == 1)
    assert [r['ui_id'] for r in pushed['event']['reminders']] == [series_id]
    r = pushed['event']['reminders'][0]
    assert (r['calendar'], r['match'], r['uid'], r['offset_mins'], r['priority']) == \
        ('calendar.kids', 'series', 'gym@google.com', 30, 'low')
    # an event can have any number of reminders
    await client.send_json({'id': 3, 'type': 'alert2/hm/reminders/save', **req(match='event', recurrence_id=occ, offset_mins=1440)})
    msgs = [await client.receive_json(), await client.receive_json()]
    one_id = next(m for m in msgs if m['id'] == 3)['result']['ui_id']
    assert len(next(m for m in msgs if m['id'] == 1)['event']['reminders']) == 2

    # deleting one occurrence takes its own reminder, not the series'
    await client.send_json({'id': 4, 'type': 'alert2/hm/reminders/delete', 'calendar': 'calendar.kids',
                            'uid': 'gym@google.com', 'recurrence_id': occ})
    msgs = [await client.receive_json(), await client.receive_json()]
    assert next(m for m in msgs if m['id'] == 4)['result']['deleted'] == [one_id]
    assert [x['ui_id'] for x in next(m for m in msgs if m['id'] == 1)['event']['reminders']] == [series_id]
    # by title: listed as such, with no event of its own
    await client.send_json({'id': 5, 'type': 'alert2/hm/reminders/save', **req(match='title', uid=None, title='Gymnastics')})
    msgs = [await client.receive_json(), await client.receive_json()]
    title_id = next(m for m in msgs if m['id'] == 5)['result']['ui_id']
    listed = next(m for m in msgs if m['id'] == 1)['event']['reminders']
    t = next(x for x in listed if x['ui_id'] == title_id)
    assert (t['match'], t['title'], t['uid']) == ('title', 'Gymnastics', None)
    # deleting the series takes every reminder of it - not the one by title, which is about
    # every Gymnastics, this series' or not
    await client.send_json({'id': 6, 'type': 'alert2/hm/reminders/delete', 'calendar': 'calendar.kids',
                            'uid': 'gym@google.com'})
    msgs = [await client.receive_json(), await client.receive_json()]
    assert next(m for m in msgs if m['id'] == 6)['result']['deleted'] == [series_id]
    assert [x['ui_id'] for x in next(m for m in msgs if m['id'] == 1)['event']['reminders']] == [title_id]
    # a title is needed for one by title, a uid for one of an event
    msg = await ws(client, 7, type='alert2/hm/reminders/save', **req(match='title', uid=None, title='  '))
    assert not msg['success']
    msg = await ws(client, 8, type='alert2/hm/reminders/save', **req(uid=None))
    assert not msg['success']


async def test_hm_reminders_fire_for_their_event_only(hass, service_calls, freezer):
    now = dt_util.now().replace(microsecond=0)
    at = now + rawdt.timedelta(minutes=40)
    await add_calendar(hass, [ev('Gymnastics', at, 'gym@google.com', 'gym_1'),
                              ev('Cooking', at, 'cook@google.com')])
    gad = await start(hass)
    rez = await gad.hmReminders.save(req(match='event', recurrence_id='gym_1', offset_mins=30), None)
    assert 'error' not in rez, rez
    await gad.hmReminders.save(req(match='event', uid='nothing@google.com', summary='Nothing'), None)
    # by title: Cooking (any event so called), not Gymnastics at the same moment
    named = await gad.hmReminders.save(req(match='title', uid=None, title='cooking', offset_mins=30), None)
    eid = rez['entity_id']
    await hass.async_block_till_done()
    assert hass.states.get(eid).state == 'has never fired'
    freezer.move_to(at - rawdt.timedelta(minutes=30) + rawdt.timedelta(seconds=1))
    # (no asyncio.sleep under a frozen clock - it never ends)
    async_fire_time_changed(hass, at - rawdt.timedelta(minutes=30) + rawdt.timedelta(seconds=1))
    await hass.async_block_till_done()
    await hass.async_block_till_done()
    st = hass.states.get(eid)
    assert st.state != 'has never fired', st
    assert st.attributes['last_fired_message'].startswith('Gymnastics · Today, ')
    # fired once: for Gymnastics, not for Cooking at the same moment
    assert [e['kind'] for e in gad.hmTimeline.timeline(eid)[eid]] == ['created', 'fire']
    ne = named['entity_id']
    assert hass.states.get(ne).attributes['last_fired_message'].startswith('Cooking · Today, ')
    assert [e['kind'] for e in gad.hmTimeline.timeline(ne)[ne]] == ['created', 'fire']


async def test_hm_reminders_sweep_removes_reminders_of_events_that_are_gone(hass, service_calls):
    now = dt_util.now()
    cal = await add_calendar(hass, [ev('Gymnastics', now + rawdt.timedelta(days=2), 'gym@google.com', 'gym_1'),
                                    ev('Lunch', now - rawdt.timedelta(hours=3), 'lunch@google.com')])
    gad = await start(hass)
    mgr = gad.hmReminders
    keep_series = (await mgr.save(req(), None))['ui_id']
    keep_occ = (await mgr.save(req(match='event', recurrence_id='gym_1'), None))['ui_id']
    gone_occ = (await mgr.save(req(match='event', recurrence_id='gym_0'), None))['ui_id']
    gone_one = (await mgr.save(req(match='event', uid='old@google.com'), None))['ui_id']
    today = (await mgr.save(req(match='event', uid='lunch@google.com'), None))['ui_id']  # over 3 h ago: kept a day
    # by title, even with no such event at all: about events still to be made - never swept
    named = (await mgr.save(req(match='title', uid=None, title='Chess'), None))['ui_id']
    # just saved: left alone, its calendar may not have caught up
    assert await mgr.sweep() == []
    mgr._touched.clear()
    # a calendar that cannot be read removes nothing
    cal.fail = True
    assert await mgr.sweep() == []
    cal.fail = False
    assert sorted(await mgr.sweep()) == sorted([gone_occ, gone_one])
    assert sorted(r['ui_id'] for r in mgr.reminders()) == sorted([keep_series, keep_occ, today, named])
    await hass.async_block_till_done()
    # its timeline says who removed it
    eid = next(i for i in gad.hmTimeline.timeline() if gad.hmTimeline.timeline(i)[i][-1].get('user') == 'Calendar clean-up')
    assert eid


async def test_hm_reminders_targets(hass, service_calls, hass_ws_client):
    hass.data['frontend_panels'] = {
        'tablet-dashboard': Panel('lovelace', 'Tablet', 'mdi:tablet', True, 'tablet-dashboard', None, False, None, True),
        'map': Panel('lovelace', 'Map', 'mdi:map', True, 'map', None, False, None, True),
        'lovelace': Panel('lovelace', None, None, True, 'lovelace', None, False, None, False),
        'admin-only': Panel('lovelace', 'Admin', None, True, 'admin-only', None, True, None, True),
        'energy': Panel('energy', 'Energy', 'mdi:lightning-bolt', True, 'energy', None, False, None, True),
    }
    hass.data['frontend_panels_config'] = {'tablet-dashboard': {'title': 'Wall Tablet'}}
    await start(hass)
    client = await hass_ws_client(hass)
    msg = await ws(client, 1, type='alert2/hm/reminders/targets')
    assert msg['success'], msg
    res = msg['result']
    assert res['everyone'] == 'user:*' and res['user_prefix'] == 'user:'
    assert isinstance(res['users'], list)
    # the test client is an admin
    assert [d['id'] for d in res['banner']] == ['admin-only', 'tablet-dashboard']
    assert res['banner'][1] == {'id': 'tablet-dashboard', 'name': 'Wall Tablet', 'icon': 'mdi:tablet'}
