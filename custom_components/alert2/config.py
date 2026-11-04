import logging
import voluptuous as vol
from   homeassistant.exceptions import TemplateError
import homeassistant.helpers.config_validation as cv

_LOGGER = logging.getLogger(__name__)
import re
from functools import lru_cache
from   homeassistant.core import callback
from   homeassistant.helpers import template as template_helper
from   homeassistant.helpers import script
from homeassistant.util.hass_dict import HassKey
from .util import (GENERATOR_DOMAIN, PersistantNotificationHelper)

TemplateVarsType = None
RenderInfo = None

_regex_cache = lru_cache(maxsize=128)(re.compile)

def entity_id_regex_extract(seq, find, ignorecase=False):
    """Match value using regex."""
    flags = re.IGNORECASE if ignorecase else 0
    regex = _regex_cache(find, flags)
    for item in seq:
        entity_id = item.entity_id
        m = regex.match(entity_id)
        if bool(m):
            yield  { "genEntityId": entity_id, "genGroups": list(m.groups()) }

_GENERATOR_ENVIRONMENT = HassKey("template.environment_alert2_generator")
#_REMINDER_ENVIRONMENT  = HassKey("template.environment_alert2_reminder")

class CustomTemplate(template_helper.Template):
    def _get_env(self, wanted_env, extra_lambda):
        # Mostly copied from template_helper.Template::_env()
        
        # The _env() code caches environments so they're not created on each eval.
        # We can't add extra functionality to one of those because it would pollute
        # the environment that the rest of HA uses.
        # So we want our own environment. And may as well cache it like the super() version does.
        if self.hass is None:
            return _NO_HASS_ENV
        # Bypass cache if a custom log function is specified
        if self._log_fn is not None:
            ret = template_helper.TemplateEnvironment(self.hass, self._limited, self._strict, self._log_fn)
            extra_lambda(ret)
        else:
            wanted_env = _GENERATOR_ENVIRONMENT # no option for limited or strict
            if (ret := self.hass.data.get(wanted_env)) is None:
                ret = self.hass.data[wanted_env] = template_helper.TemplateEnvironment(
                    self.hass, self._limited, self._strict, self._log_fn
                )
                extra_lambda(ret)
        return ret

class JTemplate(CustomTemplate): #template_helper.Template):
    @callback
    def async_render_to_info(
            self,
            variables: TemplateVarsType = None,
            strict: bool = False,
            log_fn = None, #: Callable[[int, str], None] | None = None,
            **kwargs, #: Any,
    ) -> RenderInfo:
        ri = super().async_render_to_info()
        #_LOGGER.warning(f'Original RenderInfo: {ri}')
        # Move domains to domains_lifecycle. Unfreeze, move, then refreeze
        ri.domains_lifecycle = set(ri.domains_lifecycle)
        ri.domains_lifecycle.update(ri.domains)
        ri.domains = set() # empty set
        # leave ri.entities as is, will get refrozen
        if ri.all_states:
            ri.all_states_lifecycle = True
        ri.all_states = False

        # _freeze() assumes some variables are in an initial state
        # we need to restore those vars to _freeze results in correct vals for them:
        ri.rate_limit = None
        ri.filter_lifecycle = lambda astr: True

        ri._freeze()
        return ri
    @property
    def _env(self):
        def add(env):
            env.filters['entity_regex'] = entity_id_regex_extract
        return self._get_env(_GENERATOR_ENVIRONMENT, add)

def boolTemplate(cond):
    # we haven't done a voluptuous validation yet, so don't know what type cond is
    if isinstance(cond, str) and not template_helper.is_template_string(cond):
        try:
            x = cv.boolean(cond)
        except (vol.Invalid) as ex:
            # it's not a template and not a truthy, so assume it's an entity
            if '\'' in cond or '"' in cond:
                raise vol.Invalid(f'boolean template is neither a jinja template nor an entity: {cond}') from ex
            # TODO - Not sure if strip() is necessary. Can yaml return extra whitespace?
            cond = '{{ states("' + cond.strip() + '") }}'
    return cv.template(cond)
def floatTemplate(afloat):
    # we haven't done a voluptuous validation yet, so don't know what type afloat is
    if isinstance(afloat, str) and not template_helper.is_template_string(afloat):
        try:
            x = float(afloat)
        except (ValueError) as ex:
            # it's not a template and not a truthy, so assume it's an entity
            if '\'' in afloat or '"' in afloat:
                raise vol.Invalid(f'float template is neither a jinja template nor an entity: {afloat}') from ex
            # TODO - Not sure if strip() is necessary. Can yaml return extra whitespace?
            afloat = '{{ states("' + afloat.strip() + '") }}'
    return cv.template(afloat)

def floatLitOrTemplate(minZero=False):
    def validate(afloat):
        try:
            x = float(afloat)
        except (ValueError) as ex:
            return floatTemplate(afloat)
        except (TypeError) as ex:
            raise vol.Invalid(f'expected float or template. Got err: {ex}')
        if minZero and x < 0:
            raise vol.Invalid(f'float must be > 0, not {x}')
        return x
    return validate
    
#def jtemplate(value: Any | None) -> JTemplate:
def jtemplate(value) -> JTemplate:
    """Similar to helpers/config_validation.py:template()."""
    if value is None:
        raise vol.Invalid("Generator template is None")
    if isinstance(value, list):
        return value #jstringList(value)
    if isinstance(value, (JTemplate, template_helper.Template)):
        raise vol.Invalid("Generator template should be a string")
    if not isinstance(value, str):
        return value
    if not (hass := cv._async_get_hass_or_none()):
        # pylint: disable-next=import-outside-toplevel
        from .frame import report
        report(
            (
                "validates schema outside the event loop, "
                "which will stop working in HA Core 2025.10"
            ),
            error_if_core=False,
        )

    #template_value = template_helper.Template(str(value), hass)
    template_value = JTemplate(str(value), hass)

    try:
        template_value.ensure_valid()
    except TemplateError as ex:
        #_LOGGER.warning(f'  templ value is {value}  of type {type(value)} with exception {ex}')
        raise vol.Invalid(f"invalid template ({ex})") from ex
    return template_value


def supersedesTemplate(elem):
    if not isinstance(elem, str) or not template_helper.is_template_string(elem):
        raise vol.Invalid('Not a template string')
    return cv.template(elem)


def literalIllegalChar(elem):
    return any(e in elem for e in '[]{}\'",')

def has_atleast_oneof(alist: list, aschema):
    """Validate that at least one of the keys in alist exist."""

    if not isinstance(alist, list):
        raise vol.Invalid("expected list")
    aset = set(alist)

    def validate(obj: dict) -> dict:
        """Test at least one key in alist is in zero keys exist or one key exists in dict."""
        if not isinstance(obj, dict):
            raise vol.Invalid("expected dictionary")
        obj2 = aschema(obj)
        if len(aset & set(obj2)) < 1 :
            expected = ", ".join(str(k) for k in alist)
            raise vol.Invalid(f"must contain at least one of {expected}.")
        return obj2
    return validate

def check_off(aschema):
    """Validate that the off conditions are legal."""

    def validate(obj: dict) -> dict:
        if not isinstance(obj, dict):
            raise vol.Invalid("expected dictionary")
        obj2 = aschema(obj)
        has_off = any([k in obj2 for k in ['condition_off','trigger_off','manual_off']])
        has_on = any([k in obj2 for k in ['condition_on','trigger_on','manual_on']])
        has_both = any([k in obj2 for k in ['condition','threshold']])
        if has_off ^ has_on:
            raise vol.Invalid(f'Specs with an "off" criteria must also include an "on" criteria')

        if has_on: # and so has_off
            if has_both:
                raise vol.Invalid(f'Can not mix condition/threshold with explicit on/off criteria')
        else:
            if not has_both:
                raise vol.Invalid(f'Must specify either condition, threshold or the on/off criteria')
        return obj2
    return validate

def jstringList(afield):
    alist = cv.ensure_list(afield)
    for elem in alist:
        if isinstance(elem, str):
            if len(elem) == 0:
                raise vol.Invalid(f'Notifier can not be empty string')
            if literalIllegalChar(elem):
                raise vol.Invalid(f'Notifier has illegal chars (e.g., "[", "\'")')
        else:
            raise vol.Invalid(f'Notifier "{elem}" is type {type(elem)} rather than string')
    return alist
def jstringName(afield):
    elem = cv.string(afield)
    if len(elem) == 0:
        raise vol.Invalid(f'Empty string not allowed')
    if literalIllegalChar(elem):
        raise vol.Invalid(f'Illegal characters (e.g., "[", "\'")')
    return elem

def jProtectedTrigger(afield):
    try:
        atrigger = cv.TRIGGER_SCHEMA(afield)
    except TypeError as ty:
        raise vol.Invalid(f'Trigger spec cause type error: {ty}') from ty
    return atrigger

# Allow a template to be specified in the entity_id field of state triggers if used with
# a generator.
def jProtectedGeneratorTrigger(afield):
    alist = jProtectedTrigger(afield)
    for idx in range(len(alist)):
        ent = alist[idx]
        # as per helpers/config_validation.py::_trigger_pre_validator,
        # trigger internals still use 'platform' instead of 'trigger'
        # include 'trigger' for whenever that code changes over
        if ('platform' in ent and ent['platform'] == 'state') or \
           ('trigger' in ent and ent['trigger'] == 'state') or \
           ('platform' in ent and ent['platform'] == 'numeric_state') or \
           ('trigger' in ent and ent['trigger'] == 'numeric_state'):
            alist[idx] = vol.Schema({
                                      vol.Required('entity_id'): vol.All(cv.ensure_list, [ cv.template ]),
                                     }, extra=vol.ALLOW_EXTRA)(alist[idx])
    return alist

def jDomain(afield):
    dd = jstringName(afield)
    if dd == GENERATOR_DOMAIN:
        raise vol.Invalid(f'"{GENERATOR_DOMAIN}" is a reserved domain')
    return dd

def jDictTemplate(aval):
    if isinstance(aval, dict):
        return cv.template_complex(aval) # recurses through dict
    elif isinstance(aval, str) and template_helper.is_template_string(aval):
        return cv.template(aval)  # hopefully produces a dict
    else:
        raise vol.Invalid(f'"data" field must be either a dict or a string template that evaluates to a dict')

DEFAULTS_SCHEMA = vol.Schema({
    vol.Optional('notifier'): vol.Any(cv.template, jstringList),
    # Can be truthy or template or list of notifiers
    vol.Optional('summary_notifier'): vol.Any(cv.boolean, cv.template, jstringList),
    vol.Optional('done_notifier'): vol.Any(cv.boolean, cv.template, jstringList),
    vol.Optional('annotate_messages'): cv.boolean,
    vol.Optional('reminder_frequency_mins'): vol.All(cv.ensure_list, [vol.Coerce(float)], [vol.Range(min=0.01)]),
    vol.Optional('throttle_fires_per_mins'): vol.Any(
        None, vol.All(vol.ExactSequence([int, vol.Coerce(float)]),
                      vol.ExactSequence([vol.Range(min=1.),vol.Range(min=0.01)]))),
    vol.Optional('priority'): vol.Any('low', 'medium', 'high', msg='must be one of "low", "medium" or "high"'),
    vol.Optional('supersede_debounce_secs'): vol.All(vol.Coerce(float), vol.Range(min=0)),
    vol.Optional('icon'): cv.icon,
    vol.Optional('data'): jDictTemplate,
    #vol.Optional('done_data'): jDictTemplate,
    vol.Optional('persistent_notifier_grouping'): vol.Any(PersistantNotificationHelper.Separate,
                                                          PersistantNotificationHelper.Collapse,
                                                          PersistantNotificationHelper.CollapseAndDismiss,
                                                          msg=f'must be one of "{PersistantNotificationHelper.Separate}", "{PersistantNotificationHelper.Collapse}" or "{PersistantNotificationHelper.CollapseAndDismiss}"'),
    vol.Optional('reminder_message'): vol.Any(None, cv.template),
})
DEFAULTS_SCHEMA_INTERNAL = DEFAULTS_SCHEMA.extend({
    vol.Optional('data'): vol.Any(jDictTemplate, [ jDictTemplate ]),
    #vol.Optional('done_data'): vol.Any(jDictTemplate, [ jDictTemplate ]),
})


SINGLE_TRACKED_SCHEMA_PRE_NAME = vol.Schema({
    vol.Optional('notifier'): vol.Any(cv.template, jstringList),
    vol.Optional('summary_notifier'): vol.Any(cv.boolean, cv.template, jstringList),
    vol.Optional('persistent_notifier_grouping'): vol.Any(PersistantNotificationHelper.Separate,
                                                          PersistantNotificationHelper.Collapse,
                                                          PersistantNotificationHelper.CollapseAndDismiss,
                                                          msg=f'must be one of "{PersistantNotificationHelper.Separate}", "{PersistantNotificationHelper.Collapse}" or "{PersistantNotificationHelper.CollapseAndDismiss}"'),
    vol.Optional('friendly_name'): cv.template,
    vol.Optional('title'): cv.template,
    vol.Optional('target'): cv.template,
    vol.Optional('data'): jDictTemplate,
    vol.Optional('throttle_fires_per_mins'): vol.Schema(vol.All(vol.ExactSequence([int, vol.Coerce(float)]),
                                                                 # 0.001 hours is 3.6 seconds
                                                                 vol.ExactSequence([vol.Range(min=1.),vol.Range(min=0.01)]))),
    vol.Optional('annotate_messages'): cv.boolean,
    vol.Optional('display_msg'): vol.Any(cv.template, None),
    vol.Optional('priority'): vol.Any('low', 'medium', 'high'),
    vol.Optional('icon'): cv.icon,
    vol.Optional('ack_required'): cv.boolean,
    vol.Optional('ack_reminder_message'): cv.template,
    vol.Optional('reminder_frequency_mins'): vol.All(cv.ensure_list, [vol.Coerce(float)], [vol.Range(min=0.01)]),
    # hm: fork fields
    #   link - where the alert's details are: any address, a popup hash included. Template,
    #          watched on its own: written again whenever it renders differently (e.g. the
    #          rows of "only what this alert is about"), not only when the alert changes.
    #   rule - the simple form a rule builder made this alert from, stored untouched so the
    #          builder can re-open it. The engine never reads it.
    vol.Optional('link'): cv.template,
    #   link_mobile - the same place on the phone's dashboard. Phones are what open a
    #          notification's link, so notifications use it before `link`.
    vol.Optional('link_mobile'): cv.template,
    vol.Optional('rule'): dict,
    #   description - what the alert is for, in plain words, for whoever sees it fire.
    vol.Optional('description'): cv.string,
    #   category - the group the alert is filed under in the cards (their Category column and
    #          filter), apart from its domain, so it can change without changing the alert's
    #          entity id. Unset: the cards use the domain. The engine ignores it.
    vol.Optional('category'): cv.string,
    #   stays_firing_mins - an event alert's time as "firing" after it fires, in the cards (an
    #          event has no end of its own): minutes, 0 = until someone clears it. Unset: the
    #          cards use a day. The engine ignores it.
    vol.Optional('stays_firing_mins'): vol.All(vol.Coerce(float), vol.Range(min=0)),
    #   allow_clear - whether a person may clear the alert (reset it to OK) while it fires.
    #          Unset: yes for an event alert, no for a condition alert (that one turns OK by
    #          itself once its condition is false). Read by the cards; the engine ignores it.
    vol.Optional('allow_clear'): cv.boolean,
    #   overlay - the dashboards (their url_paths, e.g. tablet-dashboard) that show a banner
    #          across the top while the alert fires and is neither cleared nor snoozed. Drawn
    #          by the Alerts card on every dashboard; the engine only passes it on.
    vol.Optional('overlay'): vol.All(cv.ensure_list, [cv.string]),
    #   overlay_open - the dashboards (as `overlay`; a dashboard is in one or the other) that,
    #          instead of a banner, open the alert's link when it fires - the doorbell's camera
    #          on a wall tablet - and go back after a minute without a touch. Without a link they
    #          show the banner. Done by the Alerts card; the engine only passes it on.
    vol.Optional('overlay_open'): vol.All(cv.ensure_list, [cv.string]),
})

DOMAIN_NAME_DICT = {
    vol.Required('domain'): jDomain,
    vol.Required('name'): jstringName,
}
ALERT2_GLOBAL_DICT = {
    vol.Required('domain'): 'alert2',
    vol.Required('name'): 'global_exception',
    vol.Optional('exception_ignore_regexes'): vol.All(cv.ensure_list, [ cv.string ])
}
UNHANDLED_EXCEPTION_DICT = {
    vol.Required('domain'): jDomain,
    vol.Required('name'): 'unhandled_exception',
    vol.Optional('exception_ignore_regexes'): vol.All(cv.ensure_list, [ cv.string ])
}

# So if 'generator' is present, then 'name' is a template. Otherwise it's a string.
# This output useless error messages if there are extra parameters :(
SINGLE_TRACKED_SCHEMA = vol.Any(
    SINGLE_TRACKED_SCHEMA_PRE_NAME.extend(ALERT2_GLOBAL_DICT),
    SINGLE_TRACKED_SCHEMA_PRE_NAME.extend(UNHANDLED_EXCEPTION_DICT),
    SINGLE_TRACKED_SCHEMA_PRE_NAME.extend(DOMAIN_NAME_DICT)
)

SINGLE_ALERT_SCHEMA_PRE_NAME = SINGLE_TRACKED_SCHEMA_PRE_NAME.extend({
    vol.Optional('message'): cv.template,
})


ACTIONS_BLOCK = script.make_script_schema(
    {
        vol.Optional('actions'): cv.SCRIPT_SCHEMA,
    },
    script.SCRIPT_MODE_SINGLE)

# Handle validation that requires async
async def async_validate_condition_alert(hass, cfg):
    if 'actions_on' in cfg:
        aon = cfg['actions_on']
        if 'actions' not in aon:
            raise vol.Invalid(f'actions_on section missing "actions" field')
        aon['actions'] = await script.async_validate_actions_config(hass, aon['actions'])


SINGLE_ALERT_SCHEMA_EVENT_PRE_NAME = SINGLE_ALERT_SCHEMA_PRE_NAME.extend({
    #vol.Required('trigger'): jProtectedTrigger,
    vol.Optional('condition'): boolTemplate,
    vol.Optional('early_start'): cv.boolean,
    # hm: an event alert runs actions too - each time it fires
    vol.Optional('actions_on'): ACTIONS_BLOCK,
})
#SINGLE_ALERT_SCHEMA_EVENT = SINGLE_ALERT_SCHEMA_EVENT_PRE_NAME.extend({
#    vol.Required('domain'): jDomain,
#    vol.Required('name'): jstringName,
#})

THRESHOLD_SCHEMA = vol.Schema({
    vol.Required('value'): floatTemplate,
    # if hystersis is template, then min 0 is enforced in the Tracker as NonnegativeFloat
    vol.Required('hysteresis'): floatLitOrTemplate(minZero=True),
    vol.Optional('minimum'): floatLitOrTemplate(),
    vol.Optional('maximum'): floatLitOrTemplate()
})

SINGLE_ALERT_SCHEMA_CONDITION_PRE_NAME = SINGLE_ALERT_SCHEMA_PRE_NAME.extend({
    vol.Optional('condition'): boolTemplate,
    vol.Optional('threshold'): has_atleast_oneof(['minimum', 'maximum'], THRESHOLD_SCHEMA),
    vol.Optional('condition_off'): boolTemplate,
    vol.Optional('trigger_off'): jProtectedTrigger,
    vol.Optional('manual_off'): cv.boolean,
    vol.Optional('condition_on'): boolTemplate,
    vol.Optional('trigger_on'): jProtectedTrigger,
    vol.Optional('manual_on'): cv.boolean,
    vol.Optional('reminder_message'): vol.Any(None, cv.template),
    vol.Optional('done_message'): cv.template,
    vol.Optional('done_notifier'): vol.Any(cv.boolean, cv.template, jstringList),
    #vol.Optional('done_data'): jDictTemplate,
    vol.Optional('early_start'): cv.boolean,
    vol.Optional('supersede_debounce_secs'): vol.All(vol.Coerce(float), vol.Range(min=0)),
    vol.Optional('ack_reminders_only'): cv.boolean,
    vol.Optional('delay_on_secs'): floatLitOrTemplate(minZero=True),
    vol.Optional('actions_on'): ACTIONS_BLOCK,
})
DOMAIN_NAME_DICT_GEN = {
    vol.Required('domain'): cv.template,
    vol.Required('name'): cv.template,
}


GENERATOR_EXTRA = {
    vol.Required('domain'): cv.template,
    vol.Required('name'): cv.template,
    vol.Required('generator'): jtemplate,
    vol.Optional('generator_name'): jstringName,
    # Overrides 'priority'
    vol.Optional('priority'): cv.template,
}
GENERATOR_EXTRA_CONDITION = {
    vol.Optional('supersedes'): vol.Any(None, vol.All(cv.ensure_list, [ DOMAIN_NAME_DICT_GEN ]), supersedesTemplate),
    vol.Optional('trigger_off'): jProtectedGeneratorTrigger,
    vol.Optional('trigger_on'): jProtectedGeneratorTrigger,
}
GENERATOR_EXTRA_EVENT = {
    vol.Required('trigger'): jProtectedGeneratorTrigger,
}
NO_GENERATOR_EXTRA = {
    vol.Required('domain'): jDomain,
    vol.Required('name'): jstringName,
}
NO_GENERATOR_EXTRA_CONDITION = {
    vol.Optional('supersedes'): vol.Any(None, vol.All(cv.ensure_list, [ DOMAIN_NAME_DICT ])),
    vol.Optional('trigger_off'): jProtectedTrigger,
    vol.Optional('trigger_on'): jProtectedTrigger,
}
NO_GENERATOR_EXTRA_EVENT = {
    vol.Required('trigger'): jProtectedTrigger,
}

# If alert is a generator, then 'name' is a template, otherwise 'name' is a string
SINGLE_ALERT_SCHEMA_CONDITION_GEN    = check_off(SINGLE_ALERT_SCHEMA_CONDITION_PRE_NAME.extend(   GENERATOR_EXTRA).extend(   GENERATOR_EXTRA_CONDITION))
SINGLE_ALERT_SCHEMA_CONDITION_NO_GEN = check_off(SINGLE_ALERT_SCHEMA_CONDITION_PRE_NAME.extend(NO_GENERATOR_EXTRA).extend(NO_GENERATOR_EXTRA_CONDITION))
    
SINGLE_ALERT_SCHEMA_EVENT_GEN    = SINGLE_ALERT_SCHEMA_EVENT_PRE_NAME.extend(   GENERATOR_EXTRA).extend(   GENERATOR_EXTRA_EVENT)
SINGLE_ALERT_SCHEMA_EVENT_NO_GEN = SINGLE_ALERT_SCHEMA_EVENT_PRE_NAME.extend(NO_GENERATOR_EXTRA).extend(NO_GENERATOR_EXTRA_EVENT)

TOP_LEVEL_SCHEMA = vol.Schema({
    vol.Optional('defaults'): DEFAULTS_SCHEMA,
    vol.Optional('tracked'): list,
    vol.Optional('alerts'): list,
    # IF CHANGE these top-level params, update
    #   Alert2Data.init2()
    #   UiMgr.saveTopConfg()
    vol.Optional('skip_internal_errors'): cv.boolean,
    vol.Optional('notifier_startup_grace_secs'): vol.All(vol.Coerce(float), vol.Range(min=0.)),
    vol.Optional('defer_startup_notifications'): vol.Any(cv.boolean, jstringList),
    # hm: true = warnings fire the alert2_error alert and no alert2_warning alert is made.
    #     YAML only (the UI does not offer it).
    vol.Optional('merge_warnings_into_errors'): cv.boolean,
    # hm: a folder (relative to the config dir) holding every UI rule as a YAML file, read
    #     back at start-up and reload (hm_rules.py). YAML only.
    vol.Optional('rules_dir'): cv.string,
    # hm: seconds after Home Assistant has started before alerts judge their conditions and
    #     triggers (0 = at once, as upstream). Meanwhile each keeps the state it was restored
    #     with, so an integration still loading (a calendar not yet fetched, a summary sensor
    #     not yet filled) cannot resolve and re-activate it. YAML only.
    vol.Optional('start_delay_secs'): vol.All(vol.Coerce(float), vol.Range(min=0.)),
    # hm: the phones' Alerts page (an address, e.g. /mobile-dashboard/alerts). A push to a
    #     phone opens the alert there when tapped (unless the alert has a link of its own), and
    #     its "Snooze: Custom…" button opens the alert there with its snooze menu (hm_push).
    #     Unset: no such button, and a tap opens only a link. YAML only.
    vol.Optional('alerts_page'): cv.string,
})

TOP_LEVEL_SCHEMA_INTERNAL = TOP_LEVEL_SCHEMA.extend({
    vol.Optional('defaults'): DEFAULTS_SCHEMA_INTERNAL })

# Called automatically as some part of startup.
#async def async_validate_config(hass, config):
#    _LOGGER.warning(f'!!!!!!!!: {config}')
