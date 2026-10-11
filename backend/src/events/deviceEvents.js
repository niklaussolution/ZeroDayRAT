const EventEmitter = require("events");

class DeviceEventEmitter extends EventEmitter {}
const deviceEvents = new DeviceEventEmitter();
deviceEvents.setMaxListeners(200);

module.exports = {
  deviceEvents,
  emitDeviceEvent: (deviceId, payload) => {
    if (!deviceId) return;
    deviceEvents.emit(`device:${deviceId}`, payload);
  },
};
