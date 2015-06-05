/*jslint node: true */
"use strict";

module.exports = function(utils, log, mergeWithDefaults, api, ctx) {
  return function sendDirectMessage(msg, nameOrUserId, callback) {
    if(!callback) throw new Error("Callback is required for sendDirectMessage");

    log.warn("Warning - sendDirectSticker and sendDirectMessage are deprecated.");

    if(typeof nameOrUserId === "number") {
      return api.sendMessage(msg, nameOrUserId, callback);
    }

    api.getUserId(nameOrUserId, function(err, data) {
      if(err) return callback(err);

      // TODO: find the actual best entry
      var thread_id = data.entries[0].uid;
      api.sendMessage(msg, thread_id, callback);
    });
  };
};