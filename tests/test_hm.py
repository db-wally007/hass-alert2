#
# Tests for the fork's additions (marked "hm:" in the source): `link`, `rule` and the
# per-alert timeline (hm_timeline.py). Run like the upstream tests, from a checkout
# outside the Home Assistant config dir:
#     pytest tests/test_hm.py
#
import os
import sys
import asyncio
import datetime as rawdt
import pytest

from homeassistant.core import Context
from homeassistant.setup import async_setup_component
from homeassistant.util.dt import utcnow
from pytest_homeassistant_custom_component.common import async_fire_time_changed

if os.environ.get('JTESTDIR'):
    sys.path.insert(0, os.environ['JTESTDIR'])
from custom_components.alert2 import DOMAIN
import custom_components.alert2 as alert2
import custom_components.alert2.hm_timeline as hm_timeline
import custom_components.alert2.hm_push as hm_push

alert2.gGcDelaySecs = 0.1


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
async def auto_check_empty_calls(hass, service_calls):
    yield
    await hass.async_block_till_done()
    assert service_calls.isEmpty()


async def setAndWait(hass, eid, state):
    hass.states.async_set(eid, state)
    await asyncio.sleep(0.05)
    await hass.async_block_till_done()


async def start(hass, alerts, **top):
    cfg = {'alert2': {'alerts': alerts, **top}}
    assert await async_setup_component(hass, DOMAIN, cfg)
    await hass.async_start()
    await hass.async_block_till_done()
    return hass.data[DOMAIN]


def kinds(gad, eid):
    return [e['kind'] for e in gad.hmTimeline.timeline(eid)[eid]]


# ---- link --------------------------------------------------------------------

async def test_hm_link_attribute_and_notification(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'l1', 'condition': 'sensor.a',
         'link': '/tablet-dashboard/home#all-lights-popup'},
        # a template, rendered with the alert's own variables
        {'domain': 'test', 'name': 'l2', 'condition': 'sensor.a',
         'link': '/health?hm_q={{ alert_name }}'},
        # an explicit data.url wins over the link
        {'domain': 'test', 'name': 'l3', 'condition': 'sensor.a',
         'link': '/ignored', 'data': {'url': '/explicit'}},
        {'domain': 'test', 'name': 'l4', 'condition': 'sensor.a'},
    ])
    assert hass.states.get('alert2.test_l1').attributes['link'] == '/tablet-dashboard/home#all-lights-popup'
    assert hass.states.get('alert2.test_l2').attributes['link'] == '/health?hm_q=l2'
    assert 'link' not in hass.states.get('alert2.test_l4').attributes

    await setAndWait(hass, 'sensor.a', 'on')
    calls = {c[2]['message']: c[2].get('data') for c in service_calls.allCalls}
    service_calls.allCalls.clear()
    by_name = {m.split(':')[0].split()[-1]: d for m, d in calls.items()}
    assert by_name['test_l1'] == {'url': '/tablet-dashboard/home#all-lights-popup',
                                  'clickAction': '/tablet-dashboard/home#all-lights-popup'}
    assert by_name['test_l2'] == {'url': '/health?hm_q=l2', 'clickAction': '/health?hm_q=l2'}
    assert by_name['test_l3'] == {'url': '/explicit'}
    assert by_name['test_l4'] is None


async def test_hm_link_mobile(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [
        {'domain': 'test', 'name': 'm1', 'condition': 'sensor.a',
         'link': '/tablet-dashboard/home#all-lights-popup', 'link_mobile': '/mobile-dashboard/home#all-lights-popup'},
        {'domain': 'test', 'name': 'm2', 'condition': 'sensor.a', 'link': '/tablet-dashboard/garage'},
    ])
    a = hass.states.get('alert2.test_m1').attributes
    assert a['link'] == '/tablet-dashboard/home#all-lights-popup'
    assert a['link_mobile'] == '/mobile-dashboard/home#all-lights-popup'
    assert 'link_mobile' not in hass.states.get('alert2.test_m2').attributes
    await setAndWait(hass, 'sensor.a', 'on')
    data = {c[2]['message'].split(':')[0].split()[-1]: c[2].get('data') for c in service_calls.allCalls}
    service_calls.allCalls.clear()
    # a phone opens a notification's link: the mobile one when there is one
    assert data['test_m1'] == {'url': '/mobile-dashboard/home#all-lights-popup',
                               'clickAction': '/mobile-dashboard/home#all-lights-popup'}
    assert data['test_m2'] == {'url': '/tablet-dashboard/garage', 'clickAction': '/tablet-dashboard/garage'}


async def test_hm_link_follows_its_template(hass, service_calls):
    # "only what this alert is about": the link names what is behind the alert NOW, so it is
    # written again whenever it renders differently - not only when the alert turns on or off
    hass.states.async_set('sensor.a', 'off')
    hass.states.async_set('sensor.rows', 'x.one')
    await start(hass, [
        {'domain': 'test', 'name': 'f1', 'condition': 'sensor.a',
         'link': "/health?hm_rows={{ states('sensor.rows') }}",
         'link_mobile': "/m?hm_rows={{ states('sensor.rows') }}"},
    ])
    a = hass.states.get('alert2.test_f1').attributes
    assert a['link'] == '/health?hm_rows=x.one' and a['link_mobile'] == '/m?hm_rows=x.one'
    # the alert stays off: the links follow
    await setAndWait(hass, 'sensor.rows', 'x.one,x.two')
    a = hass.states.get('alert2.test_f1').attributes
    assert a['link'] == '/health?hm_rows=x.one,x.two' and a['link_mobile'] == '/m?hm_rows=x.one,x.two'
    # and while it is on
    await setAndWait(hass, 'sensor.a', 'on')
    service_calls.allCalls.clear()
    assert hass.states.get('alert2.test_f1').state == 'on'
    await setAndWait(hass, 'sensor.rows', 'x.three')
    st = hass.states.get('alert2.test_f1')
    assert st.state == 'on' and st.attributes['link'] == '/health?hm_rows=x.three'
    # an unchanged rendering writes nothing
    before = st.last_updated
    await setAndWait(hass, 'sensor.other', '1')
    assert hass.states.get('alert2.test_f1').last_updated == before


# ---- rule --------------------------------------------------------------------

async def test_hm_description_attribute(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [
        {'domain': 'test', 'name': 'd1', 'condition': 'sensor.a', 'description': 'What this is for.'},
        {'domain': 'test', 'name': 'd2', 'condition': 'sensor.a'},
    ], tracked=[{'domain': 'alert2', 'name': 'warning', 'friendly_name': 'Alerting Warnings',
                 'description': 'Warnings from the alerting engine.'}])
    assert hass.states.get('alert2.test_d1').attributes['description'] == 'What this is for.'
    assert 'description' not in hass.states.get('alert2.test_d2').attributes
    w = hass.states.get('alert2.alert2_warning')
    assert w.attributes['description'] == 'Warnings from the alerting engine.'
    assert w.attributes['friendly_name'] == 'Alerting Warnings'


async def test_hm_category_attribute(hass, service_calls):
    # The cards' category, apart from the domain: changed by an update, the entity id stays.
    hass.states.async_set('sensor.a', 'off')
    assert await async_setup_component(hass, DOMAIN, {'alert2': {}})
    await hass.async_block_till_done()
    gad = hass.data[DOMAIN]
    cfg = {'domain': 'rule', 'name': 'abc123', 'friendly_name': 'Garbage', 'condition': 'sensor.a',
           'notifier': 'null', 'category': 'house'}
    rez = await gad.uiMgr.createAlert(dict(cfg))
    assert 'error' not in rez, rez
    await hass.async_block_till_done()
    assert hass.states.get('alert2.rule_abc123').attributes['category'] == 'house'
    rez2 = await gad.uiMgr.updateAlert(rez['uiId'], dict(cfg, category='garden'))
    assert 'error' not in rez2, rez2
    await hass.async_block_till_done()
    assert hass.states.get('alert2.rule_abc123').attributes['category'] == 'garden'
    # unset: no attribute
    rez3 = await gad.uiMgr.updateAlert(rez['uiId'], {k: v for k, v in cfg.items() if k != 'category'})
    assert 'error' not in rez3, rez3
    await hass.async_block_till_done()
    assert 'category' not in hass.states.get('alert2.rule_abc123').attributes


async def test_hm_stays_firing_mins_attribute(hass, service_calls):
    # An event alert's time as "firing" in the cards: a number of minutes (UI text in, a number
    # out; 0 = until cleared), and no attribute when unset.
    gad = await start(hass, [])
    cfg = {'domain': 'rule', 'name': 'ev1', 'friendly_name': 'Doorbell', 'notifier': 'null',
           'trigger': '[{"trigger": "event", "event_type": "test_ring"}]', 'stays_firing_mins': '120'}
    rez = await gad.uiMgr.createAlert(dict(cfg))
    assert 'error' not in rez, rez
    await hass.async_block_till_done()
    assert hass.states.get('alert2.rule_ev1').attributes['stays_firing_mins'] == 120
    rez2 = await gad.uiMgr.updateAlert(rez['uiId'], dict(cfg, stays_firing_mins='0'))
    assert 'error' not in rez2, rez2
    await hass.async_block_till_done()
    assert hass.states.get('alert2.rule_ev1').attributes['stays_firing_mins'] == 0
    rez3 = await gad.uiMgr.updateAlert(rez['uiId'], {k: v for k, v in cfg.items() if k != 'stays_firing_mins'})
    assert 'error' not in rez3, rez3
    await hass.async_block_till_done()
    assert 'stays_firing_mins' not in hass.states.get('alert2.rule_ev1').attributes
    bad = await gad.uiMgr.createAlert(dict(cfg, name='ev2', stays_firing_mins='-5'))
    assert 'error' in bad


async def test_hm_overlay_open_attribute(hass, service_calls):
    # The dashboards that open the link instead of a banner: a list as `overlay` (UI JSON text
    # in, attribute out), no attribute when unset or empty - a rule without it reads as before.
    gad = await start(hass, [])
    cfg = {'domain': 'rule', 'name': 'ev1', 'friendly_name': 'Doorbell', 'notifier': 'null',
           'trigger': '[{"trigger": "event", "event_type": "test_ring"}]',
           'overlay': '["mobile-dashboard"]', 'overlay_open': '["tablet-dashboard", "dashboard-clock/home"]'}
    rez = await gad.uiMgr.createAlert(dict(cfg))
    assert 'error' not in rez, rez
    await hass.async_block_till_done()
    attrs = hass.states.get('alert2.rule_ev1').attributes
    assert attrs['overlay_open'] == ['tablet-dashboard', 'dashboard-clock/home']
    assert attrs['overlay'] == ['mobile-dashboard']
    rez2 = await gad.uiMgr.updateAlert(rez['uiId'], dict(cfg, overlay_open='[]'))
    assert 'error' not in rez2, rez2
    await hass.async_block_till_done()
    assert 'overlay_open' not in hass.states.get('alert2.rule_ev1').attributes
    rez3 = await gad.uiMgr.updateAlert(rez['uiId'], {k: v for k, v in cfg.items() if k != 'overlay_open'})
    assert 'error' not in rez3, rez3
    await hass.async_block_till_done()
    assert 'overlay_open' not in hass.states.get('alert2.rule_ev1').attributes


async def test_hm_rule_edited_before_ha_started(hass, service_calls):
    # A condition alert waits for HA to finish starting before it watches its condition.
    # Edited (so removed and made again) in that window, the removed one must not wake up.
    hass.states.async_set('sensor.a', 'off')
    assert await async_setup_component(hass, DOMAIN, {'alert2': {}})
    await hass.async_block_till_done()
    gad = hass.data[DOMAIN]
    cfg = {'domain': 'test', 'name': 'e1', 'condition': 'sensor.a', 'notifier': 'null'}
    rez = await gad.uiMgr.createAlert(dict(cfg))
    await hass.async_block_till_done()
    rez2 = await gad.uiMgr.updateAlert(rez['uiId'], dict(cfg, description='edited'))
    assert 'error' not in rez2, rez2
    await hass.async_block_till_done()
    await hass.async_start()
    await hass.async_block_till_done()
    await asyncio.sleep(0.1)
    await hass.async_block_till_done()
    assert hass.states.get('alert2.alert2_global_exception').state == 'has never fired'
    # and the new one does watch
    await setAndWait(hass, 'sensor.a', 'on')
    assert hass.states.get('alert2.test_e1').state == 'on'


async def test_hm_allow_clear_attribute(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'c1', 'condition': 'sensor.a', 'allow_clear': True},
        {'domain': 'test', 'name': 'c2', 'condition': 'sensor.a', 'allow_clear': False},
        {'domain': 'test', 'name': 'c3', 'condition': 'sensor.a'},
    ])
    assert hass.states.get('alert2.test_c1').attributes['allow_clear'] is True
    assert hass.states.get('alert2.test_c2').attributes['allow_clear'] is False
    # unset: no attribute, and the card falls back to the alert type
    assert 'allow_clear' not in hass.states.get('alert2.test_c3').attributes
    # through the UI layer it arrives as text
    rez = await gad.uiMgr.createAlert({'domain': 'test', 'name': 'c4', 'condition': 'sensor.a',
                                       'allow_clear': 'false'})
    assert 'uiId' in rez, rez
    await hass.async_block_till_done()
    assert hass.states.get('alert2.test_c4').attributes['allow_clear'] is False


async def test_hm_merge_warnings_into_errors(hass, service_calls):
    gad = await start(hass, [], merge_warnings_into_errors=True)
    assert hass.states.get('alert2.alert2_warning') is None
    assert hass.states.get('alert2.alert2_error') is not None
    alert2.report(DOMAIN, 'warning', 'an action failed')
    await asyncio.sleep(0.05)
    await hass.async_block_till_done()
    service_calls.popNotifyEmpty('persistent_notification', 'alert2_error: an action failed')
    fires = [e for e in gad.hmTimeline.timeline('alert2.alert2_error')['alert2.alert2_error']
             if e['kind'] == 'fire']
    assert [e['message'] for e in fires] == ['an action failed']


async def test_hm_warnings_stay_separate_by_default(hass, service_calls):
    await start(hass, [])
    assert hass.states.get('alert2.alert2_warning') is not None


async def test_hm_rule_is_accepted_and_kept(hass, service_calls):
    rule = {'if': [{'entity': 'sensor.a', 'op': 'is', 'value': 'on'}], 'for': 0}
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'r1', 'condition': 'sensor.a', 'rule': rule},
    ])
    assert hass.states.get('alert2.test_r1') is not None

    # Through the UI layer every field arrives as text; rule is JSON/YAML text and is
    # stored exactly as sent, so the builder can re-open it.
    ui = {'domain': 'test', 'name': 'r2', 'condition': 'sensor.a',
          'link': '/x#y', 'rule': '{"if": [{"entity": "sensor.a"}]}'}
    rez = await gad.uiMgr.createAlert(dict(ui))
    assert 'uiId' in rez, rez
    assert gad.uiMgr.loadAlert(rez['uiId']) == ui
    await hass.async_block_till_done()
    assert hass.states.get('alert2.test_r2').attributes['link'] == '/x#y'


# ---- a "For" wait across a restart --------------------------------------------

def _restored_wait(hass, eid, began, msg='a is on'):
    from homeassistant.core import State
    from pytest_homeassistant_custom_component.common import mock_restore_cache_with_extra_data
    mock_restore_cache_with_extra_data(hass, [(State(eid, 'off', {}), {
        'threshold_exceeded': 0, 'hm_cond_true_time': began.isoformat(), 'hm_detect_msg': msg})])


async def test_hm_wait_carries_on_after_a_restart(hass, service_calls):
    # the condition has held for 3599.5 s of a 3600 s wait when Home Assistant restarts: the
    # wait carries on - it fires in half a second, not an hour later - and is not detected anew
    _restored_wait(hass, 'alert2.test_w1', utcnow() - rawdt.timedelta(seconds=3599.5))
    hass.states.async_set('sensor.a', 'on')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'w1', 'condition': 'sensor.a', 'delay_on_secs': 3600,
         'message': 'a is {{ states("sensor.a") }}'},
    ])
    assert hass.states.get('alert2.test_w1').state == 'off'
    await asyncio.sleep(1)
    await hass.async_block_till_done()
    assert hass.states.get('alert2.test_w1').state == 'on'
    service_calls.popNotify('persistent_notification', 'a is on')
    assert 'detected' not in kinds(gad, 'alert2.test_w1')


async def test_hm_wait_cleared_while_restarting(hass, service_calls):
    # the condition no longer holds after the restart: Cleared early, naming what it was about
    _restored_wait(hass, 'alert2.test_w2', utcnow() - rawdt.timedelta(minutes=30))
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'w2', 'condition': 'sensor.a', 'delay_on_secs': 3600,
         'message': 'a is {{ states("sensor.a") }}'},
    ])
    entries = gad.hmTimeline.timeline('alert2.test_w2')['alert2.test_w2']
    assert [e['kind'] for e in entries] == ['detect_cleared']
    assert entries[0]['message'] == 'a is on'
    assert hass.states.get('alert2.test_w2').state == 'off'


async def test_hm_wait_kept_for_the_restore_data(hass, service_calls):
    # Home Assistant saves the restore data on the same stop event Alert2 shuts down on, maybe
    # after it: the shutdown must not lose when the wait began
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'w3', 'condition': 'sensor.a', 'delay_on_secs': 3600,
         'message': 'a is {{ states("sensor.a") }}'},
    ])
    await setAndWait(hass, 'sensor.a', 'on')
    ent = gad.alerts['test']['w3']
    began = ent.cond_true_time
    assert began is not None
    await ent.shutdown()
    data = ent.extra_restore_state_data.as_dict()
    assert data['hm_cond_true_time'] == began.isoformat()
    assert data['hm_detect_msg'] == 'a is on'


# ---- timeline ----------------------------------------------------------------

async def test_hm_timeline_full_lifecycle(hass, service_calls, hass_admin_user):
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 't1', 'condition': 'sensor.a', 'delay_on_secs': 0.5,
         'message': 'a is {{ states("sensor.a") }}', 'reminder_frequency_mins': [600]},
    ])
    eid = 'alert2.test_t1'

    # condition true, then false again before the delay ran out
    await setAndWait(hass, 'sensor.a', 'on')
    await setAndWait(hass, 'sensor.a', 'off')
    assert kinds(gad, eid) == ['detected', 'detect_cleared']

    # condition true for longer than the delay
    await setAndWait(hass, 'sensor.a', 'on')
    await asyncio.sleep(1)
    await hass.async_block_till_done()
    assert hass.states.get(eid).state == 'on'
    service_calls.popNotify('persistent_notification', 'a is on')

    user_ctx = Context(user_id=hass_admin_user.id)
    await hass.services.async_call('alert2', 'ack', {'entity_id': eid}, blocking=True, context=user_ctx)
    snooze = (utcnow() + rawdt.timedelta(hours=1)).isoformat()
    await hass.services.async_call('alert2', 'notification_control',
                                   {'entity_id': eid, 'enable': True, 'snooze_until': snooze},
                                   blocking=True, context=user_ctx)
    await setAndWait(hass, 'sensor.a', 'off')
    await hass.async_block_till_done()

    entries = gad.hmTimeline.timeline(eid)[eid]
    assert [e['kind'] for e in entries] == [
        'detected', 'detect_cleared', 'detected', 'notified', 'on', 'ack', 'notification_control', 'off']
    by_kind = {e['kind']: e for e in entries}
    assert by_kind['detected']['delay_secs'] == 0.5
    # Detected and Cleared early name what made the condition true: the message as it was then
    assert entries[0]['message'] == 'a is on' and entries[1]['message'] == 'a is on'
    assert by_kind['on']['message'] == 'a is on'
    assert by_kind['notified']['notifiers'] == ['persistent_notification']
    assert by_kind['notified']['reason'] == 'Fire'
    assert by_kind['ack']['user'] == hass_admin_user.name
    assert by_kind['notification_control']['user'] == hass_admin_user.name
    assert by_kind['notification_control']['enabled'] is True
    assert by_kind['notification_control']['snooze_until'] is not None
    # snoozed, so the "turned off" notification was not sent: nothing left to pop


async def test_hm_timeline_null_notifier_records_no_notification(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'n1', 'condition': 'sensor.a', 'notifier': None},
    ])
    await setAndWait(hass, 'sensor.a', 'on')
    assert kinds(gad, 'alert2.test_n1') == ['on']


async def test_hm_timeline_event_alert(hass, service_calls):
    gad = await start(hass, [
        {'domain': 'test', 'name': 'e1', 'notifier': None,
         'trigger': [{'platform': 'state', 'entity_id': 'sensor.door', 'to': 'open'}],
         'message': 'door {{ trigger.to_state.state }}'},
    ])
    await setAndWait(hass, 'sensor.door', 'open')
    entries = gad.hmTimeline.timeline('alert2.test_e1')['alert2.test_e1']
    assert [e['kind'] for e in entries] == ['fire']
    assert entries[0]['message'] == 'door open'


async def test_hm_timeline_backfills_what_the_alert_remembers(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'b1', 'condition': 'sensor.a', 'notifier': None,
         'message': 'a is {{ states("sensor.a") }}'},
        {'domain': 'test', 'name': 'b2', 'condition': 'sensor.a', 'notifier': None},
    ])
    await setAndWait(hass, 'sensor.a', 'on')
    await hass.services.async_call('alert2', 'ack', {'entity_id': 'alert2.test_b1'}, blocking=True)
    await hass.async_block_till_done()
    # as when a rule is deleted and made again: its timeline is gone, the alert comes back firing
    for eid in ('alert2.test_b1', 'alert2.test_b2'):
        gad.hmTimeline.forget(eid)
        hass.bus.async_fire('alert2_create', {'entity_id': eid})
    await hass.async_block_till_done()
    b1 = gad.hmTimeline.timeline('alert2.test_b1')['alert2.test_b1']
    assert [(e['kind'], e.get('restored')) for e in b1] == [('on', True), ('ack', True)]
    assert b1[0]['message'] == 'a is on'
    assert [e['kind'] for e in gad.hmTimeline.timeline('alert2.test_b2')['alert2.test_b2']] == ['on']
    # nothing is added twice
    hass.bus.async_fire('alert2_create', {'entity_id': 'alert2.test_b1'})
    await hass.async_block_till_done()
    assert len(gad.hmTimeline.timeline('alert2.test_b1')['alert2.test_b1']) == 2
    # an alert whose log already has its activation gets nothing
    await setAndWait(hass, 'sensor.a', 'off')
    hass.bus.async_fire('alert2_create', {'entity_id': 'alert2.test_b2'})
    await hass.async_block_till_done()
    assert [e['kind'] for e in gad.hmTimeline.timeline('alert2.test_b2')['alert2.test_b2']] == ['on', 'off']


async def test_hm_timeline_websocket(hass, service_calls, hass_ws_client):
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [{'domain': 'test', 'name': 'w1', 'condition': 'sensor.a', 'notifier': None}])
    await setAndWait(hass, 'sensor.a', 'on')
    client = await hass_ws_client(hass)
    await client.send_json({'id': 1, 'type': 'alert2/hm/timeline', 'entity_id': 'alert2.test_w1'})
    msg = await client.receive_json()
    assert msg['success']
    assert [e['kind'] for e in msg['result']['alerts']['alert2.test_w1']] == ['on']
    await client.send_json({'id': 2, 'type': 'alert2/hm/timeline'})
    msg = await client.receive_json()
    assert 'alert2.test_w1' in msg['result']['alerts']


async def test_hm_timeline_subscribe(hass, service_calls, hass_ws_client):
    # A follower gets each entry once it is recorded (a snooze changes no on/off state, and
    # its entry lands after the state write), and the whole log when a rule is deleted.
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [])
    rez = await gad.uiMgr.createAlert({'domain': 'test', 'name': 's1', 'condition': 'sensor.a', 'notifier': 'null'})
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json({'id': 1, 'type': 'alert2/hm/timeline/subscribe'})
    msg = await client.receive_json()
    assert msg['success']
    until = (utcnow() + rawdt.timedelta(hours=1)).isoformat()
    await hass.services.async_call('alert2', 'notification_control', {
        'entity_id': 'alert2.test_s1', 'enable': True, 'snooze_until': until, 'ack_at_snooze_start': False},
        blocking=True)
    await hass.async_block_till_done()
    msg = await client.receive_json()
    assert msg['type'] == 'event' and msg['id'] == 1
    assert msg['event']['entity_id'] == 'alert2.test_s1'
    assert msg['event']['entry']['kind'] == 'notification_control'
    await gad.uiMgr.deleteAlert(rez['uiId'])
    await hass.async_block_till_done()
    msg = await client.receive_json()
    assert msg['event']['entity_id'] == 'alert2.test_s1' and msg['event']['entry']['kind'] == 'deleted'
    # unsubscribed: nothing more is sent
    await client.send_json({'id': 2, 'type': 'unsubscribe_events', 'subscription': 1})
    msg = await client.receive_json()
    assert msg['success']
    assert not gad.hmTimeline._subs


async def test_hm_timeline_records_items_coming_and_going(hass, service_calls):
    # A firing alert whose message lists items: one coming or going while it stays on is an
    # entry; the same item saying something new (its time, its level) is not.
    def items(*xs):
        hass.states.async_set('sensor.items', 'x', {'items': list(xs)})
    items('dev1 (offline since A)')
    gad = await start(hass, [{'domain': 'test', 'name': 'i1', 'notifier': None,
        'condition': "{{ state_attr('sensor.items', 'items') | count > 0 }}",
        'display_msg': "{{ state_attr('sensor.items', 'items') | join('\\n') }}"}])
    await hass.async_block_till_done()
    eid = 'alert2.test_i1'
    assert hass.states.get(eid).state == 'on'
    async def settle():
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
    items('dev1 (offline since A)', 'dev2 (offline since B)')
    await settle()
    items('dev1 (offline since C)', 'dev2 15%')          # same items, new details
    await settle()
    items('dev2 14%')
    await settle()
    items()                                               # all gone: it turns off
    await settle()
    log = gad.hmTimeline.timeline(eid)[eid]
    assert [e['kind'] for e in log] == ['on', 'changed', 'changed', 'off'], log
    assert log[1]['added'] == ['dev2 (offline since B)'] and 'removed' not in log[1]
    assert log[2]['removed'] == ['dev1 (offline since C)'] and 'added' not in log[2]
    assert not gad.hmTimeline._watched


async def test_hm_timeline_catches_up_when_following_resumes(hass, service_calls):
    # Not followed for a while (Home Assistant down, the rule being saved): a change in that
    # time is recorded when the following resumes - against what it last said or, never
    # followed before, against what it said when it activated.
    hass.states.async_set('sensor.items', 'x', {'items': ['dev1 (offline since A)']})
    tpl = "{{ state_attr('sensor.items', 'items') | join('\\n') }}"
    gad = await start(hass, [{'domain': 'test', 'name': 'c1', 'notifier': None, 'message': tpl, 'display_msg': tpl,
        'condition': "{{ state_attr('sensor.items', 'items') | count > 0 }}"}])
    await hass.async_block_till_done()
    eid = 'alert2.test_c1'
    tl = gad.hmTimeline
    tl._unwatch(eid)
    tl._seen.pop(eid, None)          # as if never followed
    hass.states.async_set('sensor.items', 'x', {'items': ['dev1 (offline since A)', 'dev2 (offline since B)']})
    await hass.async_block_till_done()
    assert kinds(gad, eid) == ['on']
    tl._watch(eid, resume=True)      # e.g. after a restart
    log = tl.timeline(eid)[eid]
    assert [e['kind'] for e in log] == ['on', 'changed'] and log[1]['added'] == ['dev2 (offline since B)']
    # and against what it last said
    tl._unwatch(eid)
    hass.states.async_set('sensor.items', 'x', {'items': ['dev2 (offline since B)']})
    await hass.async_block_till_done()
    tl._watch(eid, resume=True)
    log = tl.timeline(eid)[eid]
    assert log[-1]['removed'] == ['dev1 (offline since A)']
    tl._unwatch(eid)


async def test_hm_timeline_waits_for_a_message_at_start(hass, service_calls):
    # At a start, what a message reads may not be there yet (it renders empty): that is not
    # "everything went", and when it comes, only real changes are entries.
    hass.states.async_set('sensor.flag', 'on')
    hass.states.async_set('sensor.items', 'x', {'items': ['dev1 (offline since A)']})
    gad = await start(hass, [{'domain': 'test', 'name': 'w1', 'notifier': None,
        'condition': "{{ is_state('sensor.flag', 'on') }}",
        'display_msg': "{{ (state_attr('sensor.items', 'items') or []) | join('\\n') }}"}])
    await hass.async_block_till_done()
    eid = 'alert2.test_w1'
    tl = gad.hmTimeline

    def items(*xs):
        hass.states.async_set('sensor.items', 'x', {'items': list(xs)})

    async def restart_with(seen):
        tl._unwatch(eid)
        tl._seen.pop(eid, None)
        if seen is not None:
            tl._seen[eid] = seen
        items()                                   # not there yet
        await hass.async_block_till_done()
        tl._watch(eid, resume=True)
        await hass.async_block_till_done()

    # nothing to compare with: the first full message is only the start
    await restart_with(None)
    items('dev1 (offline since A)', 'dev2 (offline since B)')
    await hass.async_block_till_done()
    await asyncio.sleep(0.05)
    assert kinds(gad, eid) == ['on'], tl.timeline(eid)
    # what it last said is kept through the empty moment
    await restart_with(['dev1 (offline since A)'])
    items('dev1 (offline since A)', 'dev3 (offline since C)')
    await hass.async_block_till_done()
    await asyncio.sleep(0.05)
    log = tl.timeline(eid)[eid]
    assert [e['kind'] for e in log] == ['on', 'changed'] and log[1]['added'] == ['dev3 (offline since C)'], log
    tl._unwatch(eid)


async def test_hm_start_delay_holds_alerts(hass, service_calls):
    # start_delay_secs: after Home Assistant started, alerts wait before judging; meanwhile
    # they keep the state they had (here: never on), then judge as usual.
    hass.states.async_set('sensor.a', 'on')
    gad = await start(hass, [{'domain': 'test', 'name': 'sd1', 'condition': 'sensor.a', 'notifier': None}],
                      start_delay_secs=30)
    assert hass.states.get('alert2.test_sd1').state == 'off'
    assert not gad.hmTimeline._live
    async_fire_time_changed(hass, utcnow() + rawdt.timedelta(seconds=31))
    await hass.async_block_till_done()
    assert hass.states.get('alert2.test_sd1').state == 'on'
    assert gad.hmTimeline._live
    # created later, an alert judges at once
    rez = await gad.uiMgr.createAlert({'domain': 'test', 'name': 'sd2', 'condition': 'sensor.a', 'notifier': 'null'})
    await hass.async_block_till_done()
    assert hass.states.get('alert2.test_sd2').state == 'on'


async def test_hm_timeline_follows_only_once_live(hass, service_calls):
    # An alert already on at a start is followed from when alerts may judge, catching up then.
    hass.states.async_set('sensor.items', 'x', {'items': ['dev1 (offline since A)']})
    tpl = "{{ (state_attr('sensor.items', 'items') or []) | join('\\n') }}"
    gad = await start(hass, [{'domain': 'test', 'name': 'l1', 'notifier': None, 'display_msg': tpl,
        'condition': "{{ (state_attr('sensor.items', 'items') or []) | count > 0 }}"}])
    await hass.async_block_till_done()
    eid = 'alert2.test_l1'
    tl = gad.hmTimeline
    tl._unwatch(eid)
    tl._live = False                                  # as at a start
    hass.bus.async_fire('alert2_create', {'entity_id': eid})
    await hass.async_block_till_done()
    assert eid in tl._pending and eid not in tl._watched
    hass.states.async_set('sensor.items', 'x', {'items': ['dev1 (offline since A)', 'dev2 (offline since B)']})
    await hass.async_block_till_done()
    tl.go_live()
    log = tl.timeline(eid)[eid]
    assert log[-1]['kind'] == 'changed' and log[-1]['added'] == ['dev2 (offline since B)']
    assert eid in tl._watched
    tl._unwatch(eid)


async def test_hm_restart_log(hass, service_calls, hass_ws_client):
    gad = await start(hass, [])
    tl = gad.hmTimeline
    assert len(tl.restarts()) == 1 and tl.restarts()[0]['stopped'] is None   # first start: no stop known
    client = await hass_ws_client(hass)
    await client.send_json({'id': 1, 'type': 'alert2/hm/timeline'})
    msg = await client.receive_json()
    assert msg['result']['restarts'] == tl.restarts()
    tl.shutdown()                                     # stopping: noted for the next start
    assert tl._data_to_save()['stopped'] is not None


async def test_hm_timeline_forget(hass, service_calls, hass_ws_client):
    hass.states.async_set('sensor.a', 'on')
    gad = await start(hass, [{'domain': 'test', 'name': 'f9', 'condition': 'sensor.a', 'notifier': None}])
    assert kinds(gad, 'alert2.test_f9') == ['on']
    client = await hass_ws_client(hass)
    await client.send_json({'id': 1, 'type': 'alert2/hm/timeline/forget', 'entity_id': 'alert2.test_f9'})
    msg = await client.receive_json()
    assert msg['success']
    assert gad.hmTimeline.timeline('alert2.test_f9') == {'alert2.test_f9': []}


def test_hm_item_key():
    assert hm_timeline.item_key('doorbell_camera (offline since Sat, Oct 3, 4:22 PM)') == 'doorbell_camera'
    assert hm_timeline.item_key('Back hall door 15%') == 'back hall door'
    assert hm_timeline.item_key('Rain gauge -85 dBm') == 'rain gauge'
    assert hm_timeline.item_key('Plastic · Tomorrow, 4:00 AM') == 'plastic'
    assert hm_timeline.item_key('Freezer is -8 °C') == 'freezer is'


async def test_hm_timeline_follows_ui_update_and_delete(hass, service_calls):
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [])
    cfg = {'domain': 'test', 'name': 'u1', 'condition': 'sensor.a', 'notifier': 'null'}
    class User:
        name = 'Tester'
    rez = await gad.uiMgr.createAlert(dict(cfg), hmUser=User())
    await hass.async_block_till_done()
    await setAndWait(hass, 'sensor.a', 'on')
    assert kinds(gad, 'alert2.test_u1') == ['created', 'on']
    # an edited rule starts afresh - no state carried over - and judges at once: still true,
    # so it activates again; the entries before the edit stay (for the history)
    rez2 = await gad.uiMgr.updateAlert(rez['uiId'], dict(cfg, message='edited'), hmUser=User())
    assert 'error' not in rez2, rez2
    await hass.async_block_till_done()
    await asyncio.sleep(0.05)
    await hass.async_block_till_done()
    assert hass.states.get('alert2.test_u1').state == 'on'
    log = gad.hmTimeline.timeline('alert2.test_u1')['alert2.test_u1']
    assert [e['kind'] for e in log] == ['created', 'on', 'edited', 'on'], log
    assert log[2]['user'] == 'Tester' and log[2]['name'] == 'u1'
    await setAndWait(hass, 'sensor.a', 'off')
    assert kinds(gad, 'alert2.test_u1')[-1] == 'off'
    # a deleted rule's timeline ends with its deletion, and stays
    assert await gad.uiMgr.deleteAlert(rez['uiId'], hmUser=User()) == {}
    assert kinds(gad, 'alert2.test_u1')[-1] == 'deleted'


async def test_hm_timeline_loads_and_prunes(hass, service_calls, hass_storage):
    old = (utcnow() - rawdt.timedelta(days=hm_timeline.RETENTION_DAYS + 1)).isoformat()
    recent = (utcnow() - rawdt.timedelta(days=1)).isoformat()
    hass_storage[hm_timeline.STORAGE_KEY] = {
        'version': hm_timeline.STORAGE_VERSION, 'key': hm_timeline.STORAGE_KEY,
        'data': {'alerts': {
            'alert2.gone': [{'t': old, 'kind': 'on'}],
            'alert2.kept': [{'t': old, 'kind': 'on'}, {'t': recent, 'kind': 'off'}],
        }},
    }
    gad = await start(hass, [])
    assert gad.hmTimeline.timeline() == {'alert2.kept': [{'t': recent, 'kind': 'off'}]}


# ---- rules as files (hm_rules.py) ---------------------------------------------

import json
import homeassistant.config as conf_util
import custom_components.alert2.ui as alert2_ui


def ui_store(alert_infos, one_time=None):
    return {'version': alert2_ui.STORAGE_VERSION, 'minor_version': 1, 'key': alert2_ui.STORAGE_KEY,
            'data': {'nextAlertUiId': 1 + max([i['uiId'] for i in alert_infos] or [0]),
                     'defaults': {}, 'alertInfos': alert_infos, 'topLevelOptions': {},
                     'oneTime': one_time or {}}}


async def reload_with(hass, monkeypatch, cfg):
    # The test harness's storage ignores a save still waiting out its delay, which real
    # Home Assistant hands back on load; write it out first.
    uiMgr = hass.data[DOMAIN].uiMgr
    await uiMgr._store.async_save(uiMgr._data_to_save())
    async def fake_cfg(thass):
        return cfg
    with monkeypatch.context() as m:
        m.setattr(conf_util, 'async_hass_config_yaml', fake_cfg)
        await hass.services.async_call('alert2', 'reload', {})
        await hass.async_block_till_done()
    await asyncio.sleep(alert2.gGcDelaySecs + 0.1)


async def test_hm_rules_dir_first_start_writes_the_store_out(hass, service_calls, hass_storage, tmp_path):
    hass.states.async_set('sensor.a', 'off')
    hass_storage[alert2_ui.STORAGE_KEY] = ui_store([{'uiId': 2, 'cfg': {
        'domain': 'test', 'name': 's1', 'condition': 'sensor.a', 'notifier': 'null',
        'allow_clear': 'false', 'description': 'line one\nline two'}}])
    rdir = tmp_path / 'alerts'
    gad = await start(hass, [], rules_dir=str(rdir))
    text = (rdir / 'test_s1.yaml').read_text()
    assert text.startswith('# Alert rule "s1" (alert2.test_s1).')
    # written for people: booleans as booleans, multi-line text as a block
    assert 'allow_clear: false\n' in text and 'description: |-\n  line one\n  line two\n' in text
    assert text.index('domain:') < text.index('condition:')
    assert hass.states.get('alert2.test_s1').attributes['description'] == 'line one\nline two'
    assert 'hm_rules_dir' in gad.uiMgr.storeData['oneTime']


async def test_hm_rules_dir_follows_ui_saves(hass, service_calls, tmp_path):
    hass.states.async_set('sensor.a', 'off')
    rdir = tmp_path / 'alerts'
    gad = await start(hass, [], rules_dir=str(rdir))
    rule = {'kind': 'state', 'entity': 'sensor.a', 'is': 'on'}
    cfg = {'domain': 'test', 'name': 'f1', 'friendly_name': 'Sensor A is on', 'condition': 'sensor.a',
           'notifier': 'null', 'rule': json.dumps(rule)}
    rez = await gad.uiMgr.createAlert(dict(cfg))
    assert 'error' not in rez, rez
    text = (rdir / 'test_f1.yaml').read_text()
    assert text.startswith('# Alert rule "Sensor A is on" (alert2.test_f1).')
    # the builder's form as YAML, last
    assert text.rstrip().endswith('rule:\n  kind: state\n  entity: sensor.a\n  is: \'on\'')
    # a rename moves the file
    assert await gad.uiMgr.updateAlert(rez['uiId'], dict(cfg, name='f2')) == {}
    assert not (rdir / 'test_f1.yaml').exists() and (rdir / 'test_f2.yaml').exists()
    assert await gad.uiMgr.deleteAlert(rez['uiId']) == {}
    assert sorted(p.name for p in rdir.iterdir()) == []


async def test_hm_rules_dir_is_read_back_on_reload(hass, service_calls, monkeypatch, tmp_path):
    hass.states.async_set('sensor.a', 'off')
    rdir = tmp_path / 'alerts'
    top = {'rules_dir': str(rdir)}
    gad = await start(hass, [], **top)
    rez = await gad.uiMgr.createAlert({'domain': 'test', 'name': 'r1', 'condition': 'sensor.a',
                                       'notifier': 'null', 'description': 'before'})
    assert 'error' not in rez, rez
    # by hand: one rule edited, one added, and a file that is not a rule
    f1 = rdir / 'test_r1.yaml'
    f1.write_text(f1.read_text().replace('description: before', 'description: after'))
    (rdir / 'mine.yaml').write_text('domain: test\nname: r2\ncondition: sensor.a\nnotifier: null\n'
                                    'rule:\n  kind: template\n')
    (rdir / 'notes.yaml').write_text('- just a list\n')
    await reload_with(hass, monkeypatch, {'alert2': top})
    service_calls.popNotifyEmpty('persistent_notification', 'notes.yaml: not a rule')
    assert hass.states.get('alert2.test_r1').attributes['description'] == 'after'
    assert hass.states.get('alert2.test_r2') is not None
    infos = {i['cfg']['name']: i for i in gad.uiMgr.storeData['alertInfos']}
    assert infos['r1']['uiId'] == rez['uiId']            # the same rule keeps its id
    assert json.loads(infos['r2']['cfg']['rule']) == {'kind': 'template'}
    # a save in the UI writes a hand-made file under the rule's own name
    assert await gad.uiMgr.updateAlert(infos['r2']['uiId'], dict(infos['r2']['cfg'], description='x')) == {}
    assert not (rdir / 'mine.yaml').exists() and (rdir / 'test_r2.yaml').exists()
    # a file deleted by hand deletes its rule
    f1.unlink()
    (rdir / 'notes.yaml').unlink()
    await reload_with(hass, monkeypatch, {'alert2': top})
    assert [i['cfg']['name'] for i in gad.uiMgr.storeData['alertInfos']] == ['r2']
    assert hass.states.get('alert2.test_r1') is None


async def test_hm_rules_dir_missing_folder_keeps_the_rules(hass, service_calls, hass_storage, tmp_path):
    hass.states.async_set('sensor.a', 'off')
    hass_storage[alert2_ui.STORAGE_KEY] = ui_store(
        [{'uiId': 1, 'cfg': {'domain': 'test', 'name': 'm1', 'condition': 'sensor.a', 'notifier': 'null'}}],
        one_time={'hm_rules_dir': '2026-10-05T00:00:00'})
    gad = await start(hass, [], rules_dir=str(tmp_path / 'typo'))
    service_calls.popNotifyEmpty('persistent_notification', 'no such folder')
    assert hass.states.get('alert2.test_m1') is not None
    assert gad.uiMgr.hmRulesDir is None


# ---- actions -----------------------------------------------------------------

async def test_hm_actions_are_told_what_the_alert_said(hass, service_calls):
    assert await async_setup_component(hass, 'input_text', {'input_text': {'got': {'initial': '', 'max': 255}}})
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [
        {'domain': 'test', 'name': 'c1', 'condition': 'sensor.a', 'notifier': None, 'message': 'freezer warm',
         'actions_on': {'actions': [{'action': 'input_text.set_value', 'target': {'entity_id': 'input_text.got'},
                                     'data': {'value': '{{ alert_entity_id }}: {{ alert_message }}'}}]}},
    ])
    await setAndWait(hass, 'sensor.a', 'on')
    await hass.async_block_till_done()
    assert hass.states.get('input_text.got').state == 'alert2.test_c1: freezer warm'
    assert kinds(gad, 'alert2.test_c1') == ['on', 'action']


async def test_hm_event_alert_runs_its_actions_every_time(hass, service_calls):
    assert await async_setup_component(hass, 'counter', {'counter': {'runs': {}}})
    assert await async_setup_component(hass, 'input_text', {'input_text': {'got': {'initial': '', 'max': 255}}})
    gad = await start(hass, [
        {'domain': 'test', 'name': 'e1', 'notifier': None,
         'trigger': [{'platform': 'state', 'entity_id': 'sensor.door', 'to': 'open'}],
         'message': 'door {{ trigger.to_state.state }}',
         'actions_on': {'mode': 'queued', 'actions': [
             {'action': 'counter.increment', 'target': {'entity_id': 'counter.runs'}},
             {'action': 'input_text.set_value', 'target': {'entity_id': 'input_text.got'},
              'data': {'value': '{{ alert_entity_id }}: {{ alert_message }}'}}]}},
    ])
    for state in ('open', 'closed', 'open'):
        await setAndWait(hass, 'sensor.door', state)
    await hass.async_block_till_done()
    assert hass.states.get('counter.runs').state == '2'                 # once per fire
    assert hass.states.get('input_text.got').state == 'alert2.test_e1: door open'
    assert kinds(gad, 'alert2.test_e1') == ['fire', 'action', 'fire', 'action']
    assert all(e['ok'] for e in gad.hmTimeline.timeline('alert2.test_e1')['alert2.test_e1'] if e['kind'] == 'action')


async def test_hm_event_alert_action_failure_is_on_its_timeline(hass, service_calls):
    gad = await start(hass, [
        {'domain': 'test', 'name': 'e2', 'notifier': None,
         'trigger': [{'platform': 'state', 'entity_id': 'sensor.door', 'to': 'open'}],
         'actions_on': {'actions': [{'action': 'test.nope'}]}},
    ])
    await setAndWait(hass, 'sensor.door', 'open')
    await hass.async_block_till_done()
    service_calls.popNotifyEmpty('persistent_notification', '.*test_e2 action_on saw err.*test.nope')
    [act] = [e for e in gad.hmTimeline.timeline('alert2.test_e2')['alert2.test_e2'] if e['kind'] == 'action']
    assert act['ok'] is False and 'test.nope' in act['error']


async def test_hm_event_alert_actions_are_validated(hass, service_calls):
    await start(hass, [
        {'domain': 'test', 'name': 'e3', 'notifier': None,
         'trigger': [{'platform': 'state', 'entity_id': 'sensor.door', 'to': 'open'}],
         'actions_on': {'actions': [{'actionz': 'test.nope'}]}},
    ])
    service_calls.popNotifyEmpty('persistent_notification', '.*Unable to determine action.*e3')
    assert hass.states.get('alert2.test_e3') is None


# ---- pushes to phones (hm_push) -------------------------------------------------

def _phone(hass, name='mobile_app_p1'):
    # a companion app's notify service, as the mobile_app integration registers one
    async def noop(call):
        return None
    hass.services.async_register('notify', name, noop)


def _pop_all(service_calls):
    calls = [(c[1], c[2]) for c in service_calls.allCalls]
    service_calls.allCalls.clear()
    return calls


async def test_hm_push_is_the_alerts_own(hass, service_calls):
    # a condition alert's push: tagged with it, opening it on the phones' Alerts page, with
    # the snooze buttons (no Clear: it turns OK by itself) - and taken back once it is OK
    _phone(hass)
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [
        {'domain': 'test', 'name': 'p1', 'condition': 'sensor.a', 'notifier': 'mobile_app_p1', 'done_notifier': False,
         'overlay': ['tablet-dashboard', 'mobile-dashboard'], 'message': 'a is on'},
    ], alerts_page='/mobile-dashboard/alerts')
    eid = 'alert2.test_p1'
    assert hass.states.get(eid).attributes['overlay'] == ['tablet-dashboard', 'mobile-dashboard']
    assert 'pushed_to' not in hass.states.get(eid).attributes

    await setAndWait(hass, 'sensor.a', 'on')
    [(service, args)] = _pop_all(service_calls)
    assert service == 'mobile_app_p1'
    data = args['data']
    assert data['tag'] == eid
    assert data['url'] == data['clickAction'] == f'/mobile-dashboard/alerts?alert={eid}'
    assert [a['title'] for a in data['actions']] == ['Snooze: Tomorrow Morning', 'Snooze: One Week', 'Snooze: Custom…']
    assert data['actions'][2] == {'action': 'URI', 'title': 'Snooze: Custom…',
                                  'uri': f'/mobile-dashboard/alerts?alert={eid}&snooze=1'}
    assert hass.states.get(eid).attributes['pushed_to'] == ['mobile_app_p1']

    await setAndWait(hass, 'sensor.a', 'off')
    assert _pop_all(service_calls) == [('mobile_app_p1', {'message': 'clear_notification', 'data': {'tag': eid}})]
    assert 'pushed_to' not in hass.states.get(eid).attributes


async def test_hm_push_link_wins_and_other_notifiers_are_untouched(hass, service_calls):
    _phone(hass)
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [
        {'domain': 'test', 'name': 'p2', 'condition': 'sensor.a', 'link_mobile': '/mobile-dashboard/garage',
         'notifier': ['mobile_app_p1', 'persistent_notification'], 'done_notifier': False, 'message': 'a is on'},
    ])
    await setAndWait(hass, 'sensor.a', 'on')
    calls = dict(_pop_all(service_calls))
    # the alert's own link when tapped; no alerts_page: no Custom button
    assert calls['mobile_app_p1']['data']['url'] == '/mobile-dashboard/garage'
    assert [a['title'] for a in calls['mobile_app_p1']['data']['actions']] == ['Snooze: Tomorrow Morning', 'Snooze: One Week']
    assert 'tag' not in calls['persistent_notification'].get('data', {})
    assert 'actions' not in calls['persistent_notification'].get('data', {})
    # only the phone holds a push to take back
    assert hass.states.get('alert2.test_p2').attributes['pushed_to'] == ['mobile_app_p1']
    await setAndWait(hass, 'sensor.a', 'off')
    assert _pop_all(service_calls) == [('mobile_app_p1', {'message': 'clear_notification', 'data': {'tag': 'alert2.test_p2'}})]


async def test_hm_push_buttons(hass, service_calls, hass_admin_user):
    # an event alert may be cleared: Clear is its first button. Pressed on the phone it clears
    # the alert (timeline: by whom) and takes the push back; a snooze button snoozes it as the
    # cards do (until 8:00 tomorrow), without clearing it
    _phone(hass)
    gad = await start(hass, [
        {'domain': 'test', 'name': 'p3', 'trigger': [{'platform': 'state', 'entity_id': 'sensor.door', 'to': 'open'}],
         'notifier': 'mobile_app_p1', 'message': 'door'},
    ], alerts_page='/mobile-dashboard/alerts')
    eid = 'alert2.test_p3'
    await setAndWait(hass, 'sensor.door', 'open')
    [(_, args)] = _pop_all(service_calls)
    actions = args['data']['actions']
    assert actions[0] == {'action': f'HM_ALERT2|clear|{eid}', 'title': 'Clear'}

    ctx = Context(user_id=hass_admin_user.id)   # the phone's user
    hass.bus.async_fire('mobile_app_notification_action', {'action': actions[0]['action']}, context=ctx)
    await hass.async_block_till_done()
    assert hass.states.get(eid).attributes['is_acked'] is True
    assert _pop_all(service_calls) == [('mobile_app_p1', {'message': 'clear_notification', 'data': {'tag': eid}})]
    assert 'pushed_to' not in hass.states.get(eid).attributes
    assert kinds(gad, eid)[-1] == 'ack'

    await setAndWait(hass, 'sensor.door', 'closed')
    await setAndWait(hass, 'sensor.door', 'open')
    [(_, args)] = _pop_all(service_calls)
    hass.bus.async_fire('mobile_app_notification_action', {'action': args['data']['actions'][1]['action']}, context=ctx)
    await hass.async_block_till_done()
    st = hass.states.get(eid).attributes
    until = rawdt.datetime.fromisoformat(str(st['notification_control']))
    tomorrow = (alert2.entities.dt.now() + rawdt.timedelta(days=1)).date()
    assert (until.date(), until.hour, until.minute) == (tomorrow, 8, 0)
    assert st['is_acked'] is False
    assert _pop_all(service_calls) == [('mobile_app_p1', {'message': 'clear_notification', 'data': {'tag': eid}})]


async def test_hm_push_other_apps_buttons_are_left_alone(hass, service_calls):
    _phone(hass)
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [{'domain': 'test', 'name': 'p4', 'condition': 'sensor.a', 'notifier': 'mobile_app_p1'}])
    hass.bus.async_fire('mobile_app_notification_action', {'action': 'SOMETHING_ELSE'})
    hass.bus.async_fire('mobile_app_notification_action', {'action': 'HM_ALERT2|clear|alert2.nope'})
    await hass.async_block_till_done()
    assert service_calls.isEmpty()


async def test_hm_push_replaced_by_the_ok_again_push(hass, service_calls):
    # with a done notifier the "OK again" push carries the same tag - it replaces the firing
    # one on the phone, and nothing is taken back
    _phone(hass)
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [{'domain': 'test', 'name': 'p5', 'condition': 'sensor.a', 'notifier': 'mobile_app_p1',
                        'done_notifier': True, 'message': 'a is on'}])
    await setAndWait(hass, 'sensor.a', 'on')
    _pop_all(service_calls)
    await setAndWait(hass, 'sensor.a', 'off')
    [(service, args)] = _pop_all(service_calls)
    assert service == 'mobile_app_p1' and 'turned off' in args['message']
    assert args['data']['tag'] == 'alert2.test_p5' and 'actions' not in args['data']
    assert 'pushed_to' not in hass.states.get('alert2.test_p5').attributes


# ---- push to users -----------------------------------------------------------

def _app(hass, user_id, name, push=True):
    # a device with the Home Assistant app signed in as the user, as the mobile_app integration
    # registers it - with its notify service when notifications are allowed on it
    from homeassistant.util import slugify
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    entry = MockConfigEntry(domain='mobile_app', title=name, data={
        'user_id': user_id, 'device_name': name, 'device_id': f'dev-{slugify(name)}',
        'webhook_id': f'hook-{slugify(name)}',
        'app_data': {'push_token': 'token', 'push_url': 'https://push.example'} if push else {}})
    entry.add_to_hass(hass)
    if push:
        _phone(hass, slugify(f'mobile_app_{name}'))
    return entry


async def test_hm_push_to_a_user_is_their_devices(hass, service_calls):
    # "user:<id>" pushes to each device signed in as that user (not one with notifications off,
    # not another user's), tagged as any app push; the timeline names the devices
    import homeassistant.helpers.device_registry as dr
    from pytest_homeassistant_custom_component.common import MockUser
    alice = MockUser(name='alice').add_to_hass(hass)
    bob = MockUser(name='bob').add_to_hass(hass)
    _app(hass, alice.id, 'Alice’s iPhone')
    ipad = _app(hass, alice.id, 'Alice iPad')
    _app(hass, alice.id, 'Alice Watch', push=False)
    _app(hass, bob.id, 'Bob Phone')
    # renamed in Home Assistant: its name there is the one shown
    device = dr.async_get(hass).async_get_or_create(config_entry_id=ipad.entry_id,
                                                    identifiers={('mobile_app', 'dev-alice_ipad')}, name='Alice iPad')
    dr.async_get(hass).async_update_device(device.id, name_by_user='Kitchen iPad')
    hass.states.async_set('sensor.a', 'off')
    gad = await start(hass, [{'domain': 'test', 'name': 'u1', 'condition': 'sensor.a', 'done_notifier': False,
                              'notifier': [f'user:{alice.id}'], 'message': 'a is on'}])
    await setAndWait(hass, 'sensor.a', 'on')
    calls = _pop_all(service_calls)
    assert sorted(s for s, _ in calls) == ['mobile_app_alice_ipad', 'mobile_app_alices_iphone']
    assert all(args['data']['tag'] == 'alert2.test_u1' for _, args in calls)
    [notified] = [e for e in gad.hmTimeline.timeline('alert2.test_u1')['alert2.test_u1'] if e['kind'] == 'notified']
    assert notified['notifiers'] == ['mobile_app_alices_iphone', 'mobile_app_alice_ipad']
    assert notified['names'] == ['Alice’s iPhone', 'Kitchen iPad']
    await setAndWait(hass, 'sensor.a', 'off')
    _pop_all(service_calls)


async def test_hm_push_to_everyone_once_each(hass, service_calls):
    # "user:*" is every device with the app; one also named on its own is told once
    from pytest_homeassistant_custom_component.common import MockUser
    alice = MockUser(name='alice').add_to_hass(hass)
    bob = MockUser(name='bob').add_to_hass(hass)
    _app(hass, alice.id, 'A1')
    _app(hass, bob.id, 'B1')
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [{'domain': 'test', 'name': 'u2', 'condition': 'sensor.a', 'done_notifier': False,
                        'notifier': ['user:*', 'mobile_app_b1', f'user:{bob.id}'], 'message': 'a is on'}])
    await setAndWait(hass, 'sensor.a', 'on')
    assert [s for s, _ in _pop_all(service_calls)] == ['mobile_app_a1', 'mobile_app_b1']
    await setAndWait(hass, 'sensor.a', 'off')
    _pop_all(service_calls)


async def test_hm_push_to_a_user_without_devices_tells_nobody(hass, service_calls):
    # no device (yet) - nothing to send, and nothing wrong with the rule
    hass.states.async_set('sensor.a', 'off')
    await start(hass, [{'domain': 'test', 'name': 'u3', 'condition': 'sensor.a', 'done_notifier': False,
                        'notifier': ['user:nobody'], 'message': 'a is on'}])
    await setAndWait(hass, 'sensor.a', 'on')
    assert service_calls.isEmpty()
    assert hass.states.get('alert2.alert2_error').state == 'has never fired'


async def test_hm_push_follows_a_renamed_device(hass, service_calls):
    # the app renames its notifier with the device; a user's push follows it
    from pytest_homeassistant_custom_component.common import MockUser
    alice = MockUser(name='alice').add_to_hass(hass)
    entry = _app(hass, alice.id, 'Old Name')
    await start(hass, [])
    assert hm_push.expand(hass, [f'user:{alice.id}']) == ['mobile_app_old_name']
    hass.config_entries.async_update_entry(entry, data={**entry.data, 'device_name': 'New Name'})
    assert hm_push.expand(hass, [f'user:{alice.id}', 'persistent_notification']) == [
        'mobile_app_new_name', 'persistent_notification']


async def test_hm_push_users_websocket(hass, service_calls, hass_ws_client):
    # the rule editor's list: users with a device to push to, by name, with their devices
    from pytest_homeassistant_custom_component.common import MockUser
    zed = MockUser(name='zed').add_to_hass(hass)
    amy = MockUser(name='amy').add_to_hass(hass)
    nobody = MockUser(name='nobody').add_to_hass(hass)
    MockUser(name='Home Assistant Content', system_generated=True).add_to_hass(hass)
    _app(hass, zed.id, 'Zed Phone')
    _app(hass, amy.id, 'Amy Phone')
    _app(hass, amy.id, 'Amy Tablet')
    _app(hass, amy.id, 'Amy Watch', push=False)
    await start(hass, [])
    client = await hass_ws_client(hass)
    await client.send_json({'id': 1, 'type': 'alert2/hm/push_users'})
    msg = await client.receive_json()
    assert msg['success']
    # every user (one with no device too - the editor needs its name once it was picked), not
    # the system's own; by name
    users = [u for u in msg['result']['users'] if u['name'] != 'Mock User']
    assert msg['result']['devices'] == 3
    assert users == [
        {'id': amy.id, 'name': 'amy', 'devices': [{'name': 'Amy Phone', 'notifier': 'mobile_app_amy_phone'},
                                                  {'name': 'Amy Tablet', 'notifier': 'mobile_app_amy_tablet'}]},
        {'id': nobody.id, 'name': 'nobody', 'devices': []},
        {'id': zed.id, 'name': 'zed', 'devices': [{'name': 'Zed Phone', 'notifier': 'mobile_app_zed_phone'}]}]


# ---- built-in alerts set up in the UI ------------------------------------------

async def test_hm_builtin_settings_from_the_ui_apply_at_once(hass, service_calls):
    # a built-in alert's settings saved in the UI (none in the YAML) are the live alert's at
    # once - created, then edited - and it is still the one errors are reported to
    gad = await start(hass, [], merge_warnings_into_errors=True)
    eid = 'alert2.alert2_error'
    rez = await gad.uiMgr.createAlert({'domain': 'alert2', 'name': 'error', 'friendly_name': 'HASS Alerting Errors',
                                       'priority': 'low'})
    assert 'uiId' in rez, rez
    await hass.async_block_till_done()
    st = hass.states.get(eid)
    assert (st.attributes['friendly_name'], st.attributes['priority']) == ('HASS Alerting Errors', 'low')
    rez2 = await gad.uiMgr.updateAlert(rez['uiId'], {'domain': 'alert2', 'name': 'error', 'friendly_name': 'Renamed',
                                                     'priority': 'high', 'link': '/tablet-dashboard/alerts'})
    assert rez2 == {}, rez2
    await hass.async_block_till_done()
    st = hass.states.get(eid)
    assert (st.attributes['friendly_name'], st.attributes['priority'], st.attributes['link']) == (
        'Renamed', 'high', '/tablet-dashboard/alerts')
    alert2.report(DOMAIN, 'warning', 'an action failed')
    await asyncio.sleep(0.05)
    await hass.async_block_till_done()
    # said under its new name
    service_calls.popNotifyEmpty('persistent_notification', 'Renamed: an action failed')
    assert hass.states.get(eid).attributes['last_fired_message'] == 'an action failed'


async def test_hm_builtin_set_in_yaml_keeps_its_yaml(hass, service_calls):
    # the YAML's settings win at every start, so a UI change is not made live either
    gad = await start(hass, [], tracked=[{'domain': 'alert2', 'name': 'error', 'friendly_name': 'From YAML'}])
    rez = await gad.uiMgr.createAlert({'domain': 'alert2', 'name': 'error', 'friendly_name': 'From UI'})
    assert 'uiId' in rez, rez
    await hass.async_block_till_done()
    assert hass.states.get('alert2.alert2_error').attributes['friendly_name'] == 'From YAML'
