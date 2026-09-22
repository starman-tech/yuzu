#!/usr/bin/env python3
"""Faux lecteur MPRIS « spotify » sur le bus du shell imbriqué.

Usage : fake-mpris.py <fichier contenant DBUS_SESSION_BUS_ADDRESS> [image]
Expose org.mpris.MediaPlayer2.spotify avec un morceau en lecture, une
pochette locale, une position qui avance, et répond à PlayPause / Next /
Previous / Shuffle / LoopStatus / SetPosition.
"""
import glob
import sys
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

addr = open(sys.argv[1]).read().strip()
art = sys.argv[2] if len(sys.argv) > 2 else (glob.glob('/usr/share/backgrounds/**/*.jpg', recursive=True)
                                            + glob.glob('/usr/share/backgrounds/**/*.png', recursive=True))[0]
print('pochette :', art, flush=True)

XML = '''<node>
 <interface name="org.mpris.MediaPlayer2">
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
 </interface>
 <interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Next"/><method name="Previous"/>
  <method name="Seek"><arg type="x" direction="in"/></method>
  <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="LoopStatus" type="s" access="readwrite"/>
  <signal name="Seeked"><arg type="x"/></signal>
 </interface>
</node>'''

TRACKS = [
    ('Midnight City — un titre volontairement long pour tester le défilement', ['M83'], 243_000_000),
    ('Redbone', ['Childish Gambino'], 326_000_000),
    ('Nightcall', ['Kavinsky', 'Lovefoxxx'], 258_000_000),
]

state = {'index': 0, 'status': 'Playing', 'shuffle': False, 'loop': 'None',
         'started': time.monotonic(), 'offset': 0}


def position_us():
    if state['status'] != 'Playing':
        return state['offset']
    return state['offset'] + int((time.monotonic() - state['started']) * 1_000_000)


def metadata():
    title, artists, length = TRACKS[state['index']]
    return GLib.Variant('a{sv}', {
        'mpris:trackid': GLib.Variant('o', f'/org/mpris/MediaPlayer2/Track/{state["index"]}'),
        'mpris:length': GLib.Variant('x', length),
        'mpris:artUrl': GLib.Variant('s', f'file://{art}'),
        'xesam:title': GLib.Variant('s', title),
        'xesam:artist': GLib.Variant('as', artists),
        'xesam:album': GLib.Variant('s', 'Test'),
    })


conn = Gio.DBusConnection.new_for_address_sync(
    addr,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    None, None)


def emit_changed(props):
    conn.emit_signal(None, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties',
                     'PropertiesChanged',
                     GLib.Variant('(sa{sv}as)', ['org.mpris.MediaPlayer2.Player', props, []]))


def get_prop(_c, _s, _p, iface, name):
    if iface == 'org.mpris.MediaPlayer2':
        return GLib.Variant('s', {'Identity': 'Spotify (faux)', 'DesktopEntry': 'spotify'}[name])
    return {
        'Metadata': metadata,
        'PlaybackStatus': lambda: GLib.Variant('s', state['status']),
        'CanSeek': lambda: GLib.Variant('b', True),
        'Position': lambda: GLib.Variant('x', position_us()),
        'Shuffle': lambda: GLib.Variant('b', state['shuffle']),
        'LoopStatus': lambda: GLib.Variant('s', state['loop']),
    }[name]()


def set_prop(_c, _s, _p, _iface, name, value):
    if name == 'Shuffle':
        state['shuffle'] = value.get_boolean()
        emit_changed({'Shuffle': value})
    elif name == 'LoopStatus':
        state['loop'] = value.get_string()
        emit_changed({'LoopStatus': value})
    print('set', name, value, flush=True)
    return True


def method_call(_c, _s, _p, _iface, method, params, invocation):
    print('appel', method, params, flush=True)
    if method == 'PlayPause':
        if state['status'] == 'Playing':
            state['offset'] = position_us()
            state['status'] = 'Paused'
        else:
            state['started'] = time.monotonic()
            state['status'] = 'Playing'
        emit_changed({'PlaybackStatus': GLib.Variant('s', state['status'])})
    elif method in ('Next', 'Previous'):
        state['index'] = (state['index'] + (1 if method == 'Next' else -1)) % len(TRACKS)
        state['offset'] = 0
        state['started'] = time.monotonic()
        emit_changed({'Metadata': metadata()})
    elif method == 'SetPosition':
        _track, pos = params.unpack()
        state['offset'] = pos
        state['started'] = time.monotonic()
        conn.emit_signal(None, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
                         'Seeked', GLib.Variant('(x)', [pos]))
    invocation.return_value(None)


info = Gio.DBusNodeInfo.new_for_xml(XML)
for iface in info.interfaces:
    conn.register_object('/org/mpris/MediaPlayer2', iface, method_call, get_prop, set_prop)
Gio.bus_own_name_on_connection(conn, 'org.mpris.MediaPlayer2.spotify',
                               Gio.BusNameOwnerFlags.NONE, None, None)
print('faux Spotify en lecture', flush=True)
GLib.MainLoop().run()
