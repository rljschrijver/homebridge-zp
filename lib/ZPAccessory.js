// homebridge-zp/lib/ZPAccessory.js
// Copyright © 2016-2018 Erik Baauw. All rights reserved.
//
// Homebridge plugin for Sonos ZonePlayer.

'use strict'

const ZPAlarmModule = require('./ZPAlarm')
const ZPAlarm = ZPAlarmModule.ZPAlarm

const events = require('events')
const request = require('request')
const SonosModule = require('sonos')
const util = require('util')
const xml2js = require('xml2js')

module.exports = {
  setHomebridge: setHomebridge,
  ZPAccessory: ZPAccessory
}

// let Accessory
let Service
let Characteristic

function setHomebridge (Homebridge) {
  // Accessory = Homebridge.platformAccessory
  Service = Homebridge.hap.Service
  Characteristic = Homebridge.hap.Characteristic
}

// ===== SONOS ACCESSORY =======================================================

// Constructor for ZPAccessory.
function ZPAccessory (platform, zp) {
  // jshint -W106
  this.name = zp.zone + ' Sonos'
  this.uuid_base = zp.id
  this.zp = zp
  this.platform = platform
  this.subscriptions = {}
  this.state = {
    group: {},
    zone: {}
  }
  this.log = this.platform.log
  this.parser = new xml2js.Parser()

  this.infoService = new Service.AccessoryInformation()
  this.infoService
    .setCharacteristic(Characteristic.Manufacturer, 'homebridge-zp')
    .setCharacteristic(Characteristic.Model, this.zp.model)
    .setCharacteristic(Characteristic.SerialNumber, this.uuid_base)
    .setCharacteristic(Characteristic.FirmwareRevision, this.zp.version)
  this.services = [this.infoService]

  this.groupService = new this.platform.SpeakerService(this.name, 'group')
  this.groupService.addOptionalCharacteristic(Characteristic.On)
  this.groupService.getCharacteristic(Characteristic.On)
    .on('set', this.setGroupOn.bind(this))
  this.groupService.addOptionalCharacteristic(this.platform.VolumeCharacteristic)
  this.groupService.getCharacteristic(this.platform.VolumeCharacteristic)
    .on('set', this.setGroupVolume.bind(this))
  this.groupService.addOptionalCharacteristic(Characteristic.Mute)
  this.groupService.getCharacteristic(Characteristic.Mute)
    .on('set', this.setGroupMute.bind(this))
  // this.groupService.addOptionalCharacteristic(Characteristic.ChangeTrack);
  // this.groupService.getCharacteristic(Characteristic.ChangeTrack)
  //   .on('set', this.setGroupChangeTrack.bind(this));
  this.groupService.addOptionalCharacteristic(Characteristic.CurrentTrack)
  this.groupService.addOptionalCharacteristic(Characteristic.SonosGroup)
  this.services.push(this.groupService)

  this.zoneService = new this.platform.SpeakerService(
    this.zp.zone + ' Speakers', 'zone'
  )
  this.zoneService.addOptionalCharacteristic(Characteristic.On)
  this.zoneService.getCharacteristic(Characteristic.On)
    .on('set', this.setZoneOn.bind(this))
  this.zoneService.addOptionalCharacteristic(this.platform.VolumeCharacteristic)
  this.zoneService.getCharacteristic(this.platform.VolumeCharacteristic)
    .on('set', this.setZoneVolume.bind(this))
  this.zoneService.addOptionalCharacteristic(Characteristic.Mute)
  this.zoneService.getCharacteristic(Characteristic.Mute)
    .on('set', this.setZoneMute.bind(this))
  this.zoneService.addOptionalCharacteristic(Characteristic.Bass)
  this.zoneService.getCharacteristic(Characteristic.Bass)
    .on('set', this.setZoneBass.bind(this))
  this.zoneService.addOptionalCharacteristic(Characteristic.Treble)
  this.zoneService.getCharacteristic(Characteristic.Treble)
    .on('set', this.setZoneTreble.bind(this))
  this.zoneService.addOptionalCharacteristic(Characteristic.Loudness)
  this.zoneService.getCharacteristic(Characteristic.Loudness)
    .on('set', this.setZoneLoudness.bind(this))
  if (this.platform.speakers) {
    this.services.push(this.zoneService)
  }

  this.alarms = {}
  if (this.platform.alarms) {
    for (let id in zp.alarms) {
      const alarm = zp.alarms[id]
      this.alarms[alarm.ID] = new ZPAlarm(this, alarm)
      this.services.push(this.alarms[alarm.ID].service)
      this.hasAlarms = true
    }
  }

  this.avTransport = new SonosModule.Services.AVTransport(this.zp.host, this.zp.port)
  this.renderingControl = new SonosModule.Services.RenderingControl(this.zp.host, this.zp.port)
  this.groupRenderingControl = new SonosModule.Services.GroupRenderingControl(this.zp.host, this.zp.port)
  this.alarmClock = new SonosModule.Services.AlarmClock(this.zp.host, this.zp.port)

  this.on('GroupManagement', this.handleGroupManagementEvent)
  this.on('AVTransport', this.handleAVTransportEvent)
  this.on('RenderingControl', this.handleRenderingControlEvent)
  this.on('GroupRenderingControl', this.handleGroupRenderingControlEvent)
  this.on('AlarmClock', this.handleAlarmClockEvent)

  this.createSubscriptions()
}

util.inherits(ZPAccessory, events.EventEmitter)

// Called by homebridge to initialise a static accessory.
ZPAccessory.prototype.getServices = function () {
  return this.services
}

// Return array of members.
ZPAccessory.prototype.members = function () {
  if (!this.isCoordinator) {
    return []
  }
  return this.platform.groupMembers(this.group)
}

// Copy group characteristic values from group coordinator.
ZPAccessory.prototype.copyCoordinator = function () {
  const coordinator = this.coordinator
  if (coordinator && coordinator !== this) {
    coordinator.becomePlatformCoordinator()
    this.log.debug('%s: copy group characteristics from %s', this.name, coordinator.name)
    if (this.state.group.on !== coordinator.state.group.on) {
      this.log.debug(
        '%s: set member power (play/pause) from %s to %s', this.name,
        this.state.group.on, coordinator.state.group.on
      )
      this.state.group.on = coordinator.state.group.on
      this.groupService.setCharacteristic(Characteristic.On, this.state.group.on)
    }
    if (this.state.group.volume !== coordinator.state.group.volume) {
      this.log.debug(
        '%s: set member group volume from %s to %s', this.name,
        this.state.group.volume, coordinator.state.group.volume
      )
      this.state.group.volume = coordinator.state.group.volume
      this.groupService.setCharacteristic(this.platform.VolumeCharacteristic, this.state.group.volume)
    }
    if (this.state.group.mute !== coordinator.state.group.mute) {
      this.log.debug(
        '%s: set member group mute from %s to %s', this.name,
        this.state.group.mute, coordinator.state.group.mute
      )
      this.state.group.mute = coordinator.state.group.mute
      this.groupService.setCharacteristic(Characteristic.Mute, this.state.group.mute)
    }
    if (this.state.group.track !== coordinator.state.group.track) {
      this.log.debug(
        '%s: set member track from %s to %s', this.name,
        this.state.group.track, coordinator.state.group.track
      )
      this.state.group.track = coordinator.state.group.track
      this.groupService.setCharacteristic(Characteristic.CurrentTrack, this.state.group.track)
    }
    if (this.state.group.name !== coordinator.state.group.name) {
      this.log.debug(
        '%s: set member sonos group from %s to %s', this.name,
        this.state.group.name, coordinator.state.group.name
      )
      this.state.group.name = coordinator.state.group.name
      this.groupService.setCharacteristic(Characteristic.SonosGroup, this.state.group.name)
    }
  }
}

ZPAccessory.prototype.becomePlatformCoordinator = function () {
  if (!this.platform.coordinator) {
    this.log('%s: platform coordinator', this.name)
    this.platform.coordinator = this
    this.state.zone.on = true
    this.zoneService.setCharacteristic(Characteristic.On, this.state.zone.on)
  }
}

ZPAccessory.prototype.quitPlatformCoordinator = function () {
  if (this.platform.coordinator === this) {
    this.platform.coordinator = null
  }
  this.state.zone.on = false
  this.zoneService.setCharacteristic(Characteristic.On, this.state.zone.on)
}

// ===== SONOS EVENTS ==========================================================

ZPAccessory.prototype.createSubscriptions = function () {
  this.subscribe('GroupManagement', (err) => {
    if (err) {
      this.log.error('%s: subscribe to GroupManagement events: %s', this.name, err)
    }
    setTimeout(() => {
      // Give homebridge-zp some time to setup groups.
      for (const member of this.members()) {
        member.coordinator = this
        member.log.info('%s: member of group %s', member.name, member.coordinator.name)
        member.copyCoordinator()
      }
      this.subscribe('MediaRenderer/AVTransport', (err) => {
        if (err) {
          this.log.error('%s: subscribe to AVTransport events: %s', this.name, err)
        }
        this.subscribe('MediaRenderer/GroupRenderingControl', (err) => {
          if (err) {
            this.log.error('%s: subscribe to GroupRenderingControl events: %s', this.name, err)
          }
          if (this.platform.speakers) {
            this.subscribe('MediaRenderer/RenderingControl', (err) => {
              if (err) {
                this.log.error('%s: subscribe to RenderingControl events: %s', this.name, err)
              }
            })
          }
          if (this.hasAlarms) {
            this.subscribe('AlarmClock', (err) => {
              if (err) {
                this.log.error('%s: subscribe to AlarmClock events: %s', this.name, err)
              }
            })
          }
        })
      })
    }, 200)
  })
}

ZPAccessory.prototype.onExit = function () {
  for (const service in this.subscriptions) {
    const sid = this.subscriptions[service]
    this.unsubscribe(sid, service)
  }
}

ZPAccessory.prototype.handleGroupManagementEvent = function (data) {
  this.log.debug('%s: GroupManagement event', this.name)
  this.isCoordinator = data.GroupCoordinatorIsLocal === '1'
  this.group = data.LocalGroupUUID
  if (this.isCoordinator) {
    this.coordinator = this
    this.state.group.name = this.coordinator.zp.zone
    this.log.info('%s: coordinator for group %s', this.name, this.state.group.name)
    this.groupService.setCharacteristic(Characteristic.SonosGroup, this.state.group.name)
    for (const member of this.members()) {
      member.coordinator = this
      member.copyCoordinator()
    }
    if (this.platform.coordinator !== this) {
      this.state.zone.on = false
      this.zoneService.setCharacteristic(Characteristic.On, this.state.zone.on)
    }
  } else {
    this.coordinator = this.platform.groupCoordinator(this.group)
    if (this.coordinator) {
      this.log.info('%s: member of group %s', this.name, this.coordinator.zp.zone)
      this.copyCoordinator()
    }
    this.state.zone.on = true
    this.zoneService.setCharacteristic(Characteristic.On, this.state.zone.on)
  }
}

ZPAccessory.prototype.handleAVTransportEvent = function (data) {
  this.log.debug('%s: AVTransport event', this.name)
  this.parser.parseString(data.LastChange, (err, json) => {
    if (err) {
      return
    }
    let on = this.state.group.on
    let track = this.state.group.track
    const event = json.Event.InstanceID[0]
    // this.log.debug('%s: AVTransport event: %j', this.name, event);
    if (event.TransportState) {
      on = event.TransportState[0].$.val === 'PLAYING'
    }
    if (event.CurrentTrackMetaData) {
      const data = event.CurrentTrackMetaData[0].$.val
      if (data) {
        this.parser.parseString(data, (err, json) => {
          if (!err && json['DIDL-Lite']) {
            const item = json['DIDL-Lite'].item[0]
            const type = item.res[0]._
            switch (type.split(':')[0]) {
              case 'x-rincon-stream': // Line in input.
                track = item['dc:title'][0] // source
                break
              case 'x-sonos-htastream': // SPDIF TV input.
                track = 'TV'
                const streamInfo = item['r:streamInfo'][0]
                // "0": no input; "2": stereo; "18": Dolby Digital 5.1;
                on = streamInfo !== '0'
                break
              case 'x-sonosapi-stream': // Radio stream.
                track = item['r:streamContent'][0] // info
                if (track === '') {
                  if (event['r:EnqueuedTransportURIMetaData']) {
                    const data = event['r:EnqueuedTransportURIMetaData'][0].$.val
                    if (data) {
                      this.parser.parseString(data, (err, json) => {
                        if (err) {
                          return
                        }
                        if (json['DIDL-Lite']) {
                          track = json['DIDL-Lite'].item[0]['dc:title'][0] // station
                        }
                      })
                    }
                  }
                }
                break
              case 'x-file-cifs': // Library song.
              case 'x-sonos-spotify': // Spotify song.
                track = item['dc:title'][0] // song
                // track = item['dc:creator'][0]; // artist
                // track = item['upnp:album'][0]; // album
                // track = item.res[0].$.duration; // duration
                break
              default:
                if (item['dc:title']) {
                  track = item['dc:title'][0] // song
                } else {
                  this.log.warn('%s: unknown track metadata %j', this.name, item)
                  track = '(unknown)'
                }
                break
            }
          }
        })
      }
    }
    if (on !== this.state.group.on) {
      this.log.info('%s: power (play/pause) changed from %s to %s', this.name, this.state.group.on, on)
      this.state.group.on = on
      this.groupService.setCharacteristic(Characteristic.On, this.state.group.on)
      for (const member of this.members()) {
        member.copyCoordinator(this)
      }
    }
    if (track !== this.state.group.track &&
        track !== 'ZPSTR_CONNECTING' && track !== 'ZPSTR_BUFFERING') {
      this.log.info(
        '%s: current track changed from %s to %s', this.name,
        this.state.group.track, track
      )
      this.state.group.track = track
      this.groupService.setCharacteristic(Characteristic.CurrentTrack, this.state.group.track)
      for (const member of this.members()) {
        member.copyCoordinator()
      }
    }
  })
}

ZPAccessory.prototype.handleGroupRenderingControlEvent = function (json) {
  this.log.debug('%s: GroupRenderingControl event', this.name)
  if (json.GroupVolume) {
    const volume = Number(json.GroupVolume)
    if (volume !== this.state.group.volume) {
      this.log.info('%s: group volume changed from %s to %s', this.name, this.state.group.volume, volume)
      this.state.group.volume = volume
      this.groupService.setCharacteristic(this.platform.VolumeCharacteristic, this.state.group.volume)
      for (const member of this.members()) {
        member.copyCoordinator(this)
      }
    }
  }
  if (json.GroupMute) {
    const mute = json.GroupMute === '1'
    if (mute !== this.state.group.mute) {
      this.log.info('%s: group mute changed from %s to %s', this.name, this.state.group.mute, mute)
      this.state.group.mute = mute
      this.groupService.setCharacteristic(Characteristic.Mute, this.state.group.mute)
      for (const member of this.members()) {
        member.copyCoordinator(this)
      }
    }
  }
}

ZPAccessory.prototype.handleRenderingControlEvent = function (data) {
  this.log.debug('%s: RenderingControl event', this.name)
  this.parser.parseString(data.LastChange, (err, json) => {
    if (err) {
      return
    }
    const event = json.Event.InstanceID[0]
    if (event.Volume) {
      const volume = Number(event.Volume[0].$.val)
      if (volume !== this.state.zone.volume) {
        this.log.info('%s: volume changed from %s to %s', this.name, this.state.zone.volume, volume)
        this.state.zone.volume = volume
        this.zoneService.setCharacteristic(this.platform.VolumeCharacteristic, this.state.zone.volume)
      }
    }
    if (event.Mute) {
      const mute = event.Mute[0].$.val === '1'
      if (mute !== this.state.zone.mute) {
        this.log.info('%s: mute changed from %s to %s', this.name, this.state.zone.mute, mute)
        this.state.zone.mute = mute
        this.zoneService.setCharacteristic(Characteristic.Mute, this.state.zone.mute)
      }
    }
    if (event.Bass) {
      const bass = Number(event.Bass[0].$.val)
      if (bass !== this.state.zone.bass) {
        this.log.info('%s: bass changed from %s to %s', this.name, this.state.zone.bass, bass)
        this.state.zone.bass = bass
        this.zoneService.setCharacteristic(Characteristic.Bass, this.state.zone.bass)
      }
    }
    if (event.Treble) {
      const treble = Number(event.Treble[0].$.val)
      if (treble !== this.state.zone.treble) {
        this.log.info('%s: treble changed from %s to %s', this.name, this.state.zone.treble, treble)
        this.state.zone.treble = treble
        this.zoneService.setCharacteristic(Characteristic.Treble, this.state.zone.treble)
      }
    }
    if (event.Loudness) {
      const loudness = event.Loudness[0].$.val === '1'
      if (loudness !== this.state.zone.loudness) {
        this.log.info('%s: loudness changed from %s to %s', this.name, this.state.zone.loudness, loudness)
        this.state.zone.loudness = loudness
        this.zoneService.setCharacteristic(Characteristic.Loudness, this.state.zone.loudness)
      }
    }
  })
}

ZPAccessory.prototype.handleAlarmClockEvent = function (data) {
  this.log.debug('%s: AlarmClock event', this.name)
  if (data.AlarmListVersion === this.platform.alarmListVersion) {
    // Already handled.
    return
  }
  this.platform.alarmListVersion = data.AlarmListVersion
  this.log.debug(
    '%s: alarm list version %s', this.name, this.platform.alarmListVersion
  )
  this.alarmClock.ListAlarms((err, alarmClock) => {
    if (err) {
      return
    }
    for (const alarm of alarmClock.CurrentAlarmList) {
      const zp = this.platform.zpAccessories[alarm.RoomUUID]
      if (zp && zp.alarms[alarm.ID]) {
        zp.alarms[alarm.ID].handleAlarm(alarm)
      }
    }
  })
}

// ===== HOMEKIT EVENTS ========================================================

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setZoneOn = function (on, callback) {
  on = !!on
  if (this.state.zone.on === on) {
    return callback()
  }
  this.log.info('%s: set power (group membership) from %s to %s', this.name, this.state.zone.on, on)
  this.state.zone.on = on
  if (on) {
    const coordinator = this.platform.coordinator
    if (coordinator) {
      return this.join(coordinator, callback)
    }
    this.becomePlatformCoordinator()
    return callback()
  } else {
    if (this.platform.coordinator === this) {
      this.platform.coordinator = null
    }
    if (this.isCoordinator) {
      const newCoordinator = this.members()[0]
      if (newCoordinator) {
        newCoordinator.becomePlatformCoordinator()
        return this.abandon(newCoordinator, callback)
      }
      return callback()
    }
    return this.leave(callback)
  }
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setZoneVolume = function (volume, callback) {
  if (this.state.zone.volume === volume) {
    return callback()
  }
  this.log.info('%s: set volume from %s to %s', this.name, this.state.zone.volume, volume)
  this.zp.setVolume(volume + '', (err, data) => {
    if (err) {
      this.log.error('%s: set volume: %s', this.name, err)
      return callback(err)
    }
    this.state.zone.volume = volume
    return callback()
  })
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setZoneMute = function (mute, callback) {
  mute = !!mute
  if (this.state.zone.mute === mute) {
    return callback()
  }
  this.log.info('%s: set mute from %s to %s', this.name, this.state.zone.mute, mute)
  this.zp.setMuted(mute, (err, data) => {
    if (err) {
      this.log.error('%s: set mute: %s', this.name, err)
      return callback(err)
    }
    this.state.zone.mute = mute
    return callback()
  })
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setZoneBass = function (bass, callback) {
  if (this.state.zone.bass === bass) {
    return callback()
  }
  this.log.info('%s: set bass from %s to %s', this.name, this.state.zone.bass, bass)
  const args = {
    InstanceID: 0,
    DesiredBass: bass + ''
  }
  this.renderingControl._request('SetBass', args, (err, status) => {
    if (err) {
      this.log.error('%s: set bass: %s', this.name, err)
      return callback(err)
    }
    this.state.zone.bass = bass
    return callback()
  })
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setZoneTreble = function (treble, callback) {
  if (this.state.zone.treble === treble) {
    return callback()
  }
  this.log.info('%s: set treble from %s to %s', this.name, this.state.zone.treble, treble)
  const args = {
    InstanceID: 0,
    DesiredTreble: treble + ''
  }
  this.renderingControl._request('SetTreble', args, (err, status) => {
    if (err) {
      this.log.error('%s: set treble: %s', this.name, err)
      return callback(err)
    }
    this.state.zone.treble = treble
    return callback()
  })
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setZoneLoudness = function (loudness, callback) {
  loudness = !!loudness
  if (this.state.zone.loudness === loudness) {
    return callback()
  }
  this.log.info('%s: set loudness from %s to %s', this.name, this.state.zone.loudness, loudness)
  const args = {
    InstanceID: 0,
    Channel: 'Master',
    DesiredLoudness: loudness ? '1' : '0'
  }
  this.renderingControl._request('SetLoudness', args, (err, status) => {
    if (err) {
      this.log.error('%s: set loudness: %s', this.name, err)
      return callback(err)
    }
    this.state.zone.loudness = loudness
    return callback()
  })
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setGroupOn = function (on, callback) {
  on = !!on
  if (this.state.group.on === on) {
    return callback()
  }
  if (!this.isCoordinator) {
    return this.coordinator.setGroupOn(on, callback)
  }
  if (this.state.group.track === 'TV') {
    return callback(new Error())
  }
  this.log.info('%s: set power (play/pause) from %s to %s', this.name, this.state.group.on, on)
  if (on) {
    this.log.debug('%s: play', this.name)
    this.zp.play((err, success) => {
      if (err || !success) {
        this.log.error('%s: play: %s', this.name, err)
        return callback(err)
      }
      return callback()
    })
  } else {
    this.log.debug('%s: pause', this.name)
    this.zp.pause((err, success) => {
      if (err || !success) {
        this.log.error('%s: pause: %s', this.name, err)
        return callback(err)
      }
      return callback()
    })
  }
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setGroupVolume = function (volume, callback) {
  if (this.state.group.volume === volume) {
    return callback()
  }
  if (!this.isCoordinator) {
    return this.coordinator.setGroupVolume(volume, callback)
  }
  this.log.info('%s: set group volume from %s to %s', this.name, this.state.group.volume, volume)
  const args = {
    InstanceID: 0,
    DesiredVolume: volume + ''
  }
  this.groupRenderingControl._request('SetGroupVolume', args, (err, status) => {
    if (err) {
      this.log.error('%s: set group volume: %s', this.name, err)
      return callback(err)
    }
    // this.state.group.volume = volume;
    return callback()
  })
}

// Called by homebridge when characteristic is changed from homekit.
ZPAccessory.prototype.setGroupMute = function (mute, callback) {
  mute = !!mute
  if (this.state.group.mute === mute) {
    return callback()
  }
  if (!this.isCoordinator) {
    return this.coordinator.setGroupMute(mute, callback)
  }
  this.log.info('%s: set group mute from %s to %s', this.name, this.state.group.mute, mute)
  const args = {
    InstanceID: 0,
    DesiredMute: mute
  }
  this.groupRenderingControl._request('SetGroupMute', args, (err, status) => {
    if (err) {
      this.log.error('%s: set group mute: %s', this.name, err)
      return callback(err)
    }
    // this.state.group.mute = mute;
    return callback()
  })
}

// ZPAccessory.prototype.setGroupTrack = function(track, callback) {
//   if (track === 0) {
//     return callback();
//   }
//   if (track > 0) {
//     this.log.info('%s: next track', this.name);
//   } else {
//     this.log.info('%s: previous track', this.name);
//   }
//   callback();
//   setTimeout(() => {
//     this.groupService.setCharacteristic(Characteristic.Track, 0);
//   }, 100);
// };

// ===== SONOS INTERACTION =====================================================

// Join a group.
ZPAccessory.prototype.join = function (coordinator, callback) {
  this.log.debug('%s: join %s', this.name, coordinator.name)
  const args = {
    InstanceID: 0,
    CurrentURI: 'x-rincon:' + coordinator.zp.id,
    CurrentURIMetaData: null
  }
  this.avTransport.SetAVTransportURI(args, (err, status) => {
    if (err) {
      this.log.error('%s: join %s: %s', this.name, coordinator.name, err)
      return callback(err)
    }
    return callback()
  })
}

// Leave a group.
ZPAccessory.prototype.leave = function (callback) {
  const oldGroup = this.coordinator.name
  this.log.debug('%s: leave %s', this.name, oldGroup)
  const args = {
    InstanceID: 0
  }
  this.avTransport.BecomeCoordinatorOfStandaloneGroup(args, (err, status) => {
    if (err) {
      this.log.error('%s: leave %s: %s', this.name, oldGroup, err)
      return callback(err)
    }
    return callback()
  })
}

// Transfer ownership and leave a group.
ZPAccessory.prototype.abandon = function (newCoordinator, callback) {
  const oldGroup = this.coordinator.name
  this.log.debug('%s: leave %s to %s', this.name, oldGroup, newCoordinator.name)
  const args = {
    InstanceID: 0,
    NewCoordinator: newCoordinator.zp.id,
    RejoinGroup: false
  }
  this.avTransport.DelegateGroupCoordinationTo(args, (err, status) => {
    if (err) {
      this.log.error('%s: leave %s to %s: %s', this.name, oldGroup, newCoordinator.name, err)
      return callback(err)
    }
    return callback()
  })
}

// Subscribe to Sonos ZonePlayer events
ZPAccessory.prototype.subscribe = function (service, callback) {
  const subscribeUrl = 'http://' + this.zp.host + ':' + this.zp.port + '/' +
                       service + '/Event'
  const callbackUrl = this.platform.callbackUrl + '/' + this.zp.id + '/' + service
  const opt = {
    url: subscribeUrl,
    method: 'SUBSCRIBE',
    headers: {
      CALLBACK: '<' + callbackUrl + '>',
      NT: 'upnp:event',
      TIMEOUT: 'Second-' + this.platform.subscriptionTimeout
    }
  }
  this.request(opt, (err, response) => {
    if (err) {
      return callback(err)
    }
    this.log.debug(
      '%s: new %s subscription %s (timeout %s)', this.name,
      service, response.headers.sid, response.headers.timeout
    )
    this.subscriptions[service] = response.headers.sid
    setTimeout(() => {
      this.resubscribe(response.headers.sid, service)
    }, (this.platform.subscriptionTimeout - 60) * 1000)
    return callback()
  })
}

// Cancel subscription to Sonos ZonePlayer events
ZPAccessory.prototype.unsubscribe = function (sid, service) {
  const subscribeUrl = 'http://' + this.zp.host + ':' + this.zp.port + '/' +
                       service + '/Event'
  const opt = {
    url: subscribeUrl,
    method: 'UNSUBSCRIBE',
    headers: {
      SID: sid
    }
  }
  this.request(opt, (err, response) => {
    if (err) {
      this.log.error('%s: cancel %s subscription %s: %s', this.name, service, sid, err)
      return
    }
    this.log.debug(
      '%s: cancelled %s subscription %s', this.name, service, sid
    )
  })
}

// Renew subscription to Sonos ZonePlayer events
ZPAccessory.prototype.resubscribe = function (sid, service) {
  if (sid === this.subscriptions[service]) {
    this.log.debug('%s: renewing %s subscription %s', this.name, service, sid)
    const subscribeUrl = 'http://' + this.zp.host + ':' + this.zp.port + '/' +
                         service + '/Event'
    const opt = {
      url: subscribeUrl,
      method: 'SUBSCRIBE',
      headers: {
        SID: sid,
        TIMEOUT: 'Second-' + this.platform.subscriptionTimeout
      }
    }
    this.request(opt, (err, response) => {
      if (err) {
        this.log.error('%s: renew %s subscription %s: %s', this.name, service, sid, err)
        this.subscribe(service, (err) => {
          this.log.error('%s: subscribe to %s events: %s', this.name, service, err)
        })
        return
      }
      this.log.debug(
        '%s: renewed %s subscription %s (timeout %s)', this.name,
        service, response.headers.sid, response.headers.timeout
      )
      setTimeout(function () {
        this.resubscribe(response.headers.sid, service)
      }, (this.platform.subscriptionTimeout - 60) * 1000)
    })
  }
}

// Send request to Sonos ZonePlayer.
ZPAccessory.prototype.request = function (opt, callback) {
  this.log.debug('%s: %s %s', this.name, opt.method, opt.url)
  request(opt, (err, response) => {
    if (err) {
      this.log.error('%s: cannot %s %s (%s)', this.name, opt.method, opt.url, err)
      return callback(err)
    }
    if (response.statusCode !== 200) {
      this.log.error(
        '%s: cannot %s %s (%d - %s)', this.name, opt.method, opt.url,
        response.statusCode, response.statusMessage
      )
      return callback(response.statusCode)
    }
    return callback(null, response)
  })
}
