"use strict";

var utils = require("../utils");
var log = require("npmlog");
var bluebird = require("bluebird");

var allowedProperties = {
  attachment: true,
  url: true,
  sticker: true,
  emoji: true,
  emojiSize: true,
  body: true,
  mentions: true,
  location: true,
};

module.exports = function (defaultFuncs, api, ctx) {
  function uploadAttachment(attachments, callback) {
    var uploads = [];

    // create an array of promises
    for (var i = 0; i < attachments.length; i++) {
      if (!utils.isReadableStream(attachments[i])) {
        throw {
          error:
            "Attachment should be a readable stream and not " +
            utils.getType(attachments[i]) +
            ".",
        };
      }

      var form = {
        upload_1024: attachments[i],
        voice_clip: "true",
      };

      uploads.push(
        defaultFuncs
          .postFormData(
            "https://free.facebook.com/ajax/mercury/upload.php",
            ctx.jar,
            form,
            {}
          )
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then(function (resData) {
            if (resData.error) {
              throw resData;
            }

            // We have to return the data unformatted unless we want to change it
            // back in sendMessage.
            return resData.payload.metadata[0];
          })
      );
    }

    // resolve all promises
    bluebird
      .all(uploads)
      .then(function (resData) {
        callback(null, resData);
      })
      .catch(function (err) {
        log.error("uploadAttachment", err);
        return callback(err);
      });
  }

  function getUrl(url, callback) {
    var form = {
      image_height: 960,
      image_width: 960,
      uri: url,
    };

    defaultFuncs
      .post(
        "https://free.facebook.com/message_share_attachment/fromURI/",
        ctx.jar,
        form
      )
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (resData.error) {
          return callback(resData);
        }

        if (!resData.payload) {
          return callback({ error: "Invalid url" });
        }

        callback(null, resData.payload.share_data.share_params);
      })
      .catch(function (err) {
        log.error("getUrl", err);
        return callback(err);
      });
  }

  function sendContent(form, threadID, isSingleUser, messageAndOTID, callback) {
    // There are three cases here:
    // 1. threadID is of type array, where we're starting a new group chat with users
    //    specified in the array.
    // 2. User is sending a message to a specific user.
    // 3. No additional form params and the message goes to an existing group chat.
    if (utils.getType(threadID) === "Array") {
      for (var i = 0; i < threadID.length; i++) {
        form["specific_to_list[" + i + "]"] = "fbid:" + threadID[i];
      }
      form["specific_to_list[" + threadID.length + "]"] = "fbid:" + ctx.userID;
      form["client_thread_id"] = "root:" + messageAndOTID;
      log.info(
        "sendMessage",
        "Sending message to new group chat with users: " + threadID
      );
    } else if (isSingleUser) {
      form["specific_to_list[0]"] = "fbid:" + threadID;
      form["client_thread_id"] = "user:" + threadID;
      log.info("sendMessage", "Sending message to user: " + threadID);
    } else {
      form["thread_id"] = threadID;
      form["client_thread_id"] = "thread:" + threadID;
      log.info("sendMessage", "Sending message to thread: " + threadID);
    }

    defaultFuncs
      .post(
        "https://free.facebook.com/messaging/send/",
        ctx.jar,
        form
      )
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (resData.error) {
          throw resData;
        }

        return callback(null, resData.payload);
      })
      .catch(function (err) {
        log.error("sendContent", err);
        return callback(err);
      });
  }

  function send(optionsOrMessage, callback) {
    var messageAndOTID = utils.generateOfflineThreadingID();

    // First check if user passed object or plain string
    if (utils.getType(optionsOrMessage) === "Object") {
      if (
        optionsOrMessage.otherUserID ||
        optionsOrMessage.threadID ||
        optionsOrMessage.threadId ||
        optionsOrMessage.userID
      ) {
        return sendMessage(optionsOrMessage, messageAndOTID, callback);
      } else if (optionsOrMessage.sticker) {
        return sendSticker(optionsOrMessage.sticker, optionsOrMessage.threadID, callback);
      } else if (optionsOrMessage.emoji || optionsOrMessage.emojiSize) {
        return sendEmoji(optionsOrMessage.emoji, optionsOrMessage.emojiSize, optionsOrMessage.threadID, callback);
      } else if (optionsOrMessage.attachment) {
        return sendAttachment(optionsOrMessage.attachment, optionsOrMessage.threadID, callback);
      } else if (optionsOrMessage.url) {
        return sendURL(optionsOrMessage.url, optionsOrMessage.threadID, callback);
      } else if (optionsOrMessage.location) {
        return sendLocation(optionsOrMessage.location, optionsOrMessage.threadID, callback);
      } else {
        return callback({
          error: "Cannot call send() with that type of message",
        });
      }
    }

    sendMessage(optionsOrMessage, messageAndOTID, callback);
  }

  function handleUrl(message, form, messageAndOTID, callback) {
    if (!message.url) {
      return callback(null, form);
    }

    getUrl(message.url, function (err, data) {
      if (err) {
        return callback(err);
      }

      form["shareable_attachment[share_type]"] = data.share_type;
      form["shareable_attachment[share_params]"] = data.share_params;
      form[
        "shareable_attachment[share_params][canonical]" +
          data.share_type +
          "_url"
      ] = data.share_params["canonical" + data.share_type + "_url"];
      form[
        "shareable_attachment[share_params][description]" +
          data.share_type +
          "_text"
      ] = data.share_params["description" + data.share_type + "_text"];
      form["shareable_attachment[share_params][title]"] =
        data.share_params.title;
      form["shareable_attachment[share_params][url]"] =
        data.share_params.link;
      form["shareable_attachment[share_params][images][0]"] =
        data.share_params.images[0];
      sendContent(form, message.threadID, message.isGroup, messageAndOTID, callback);
    });
  }

  function sendMessage(message, messageAndOTID, callback) {
    var form = {};

    if (message.hasOwnProperty("sticker")) {
      sendSticker(message.sticker, message.threadID, callback);
      return;
    } else if (message.hasOwnProperty("emoji") || message.hasOwnProperty("emojiSize")) {
      sendEmoji(message.emoji, message.emojiSize, message.threadID, callback);
      return;
    } else if (message.hasOwnProperty("attachment")) {
      sendAttachment(message.attachment, message.threadID, callback);
      return;
    } else if (message.hasOwnProperty("url")) {
      sendURL(message.url, message.threadID, callback);
      return;
    } else if (message.hasOwnProperty("location")) {
      sendLocation(message.location, message.threadID, callback);
      return;
    }

    if (message.body) {
      form["body"] = message.body;
    } else {
      return callback({
        error: "Cannot send message without content",
      });
    }

    if (message.hasOwnProperty("mentions")) {
      form["has_attachment"] = "true";
      form["specific_to_list[0]"] = "fbid:" + ctx.userID;
      form["client_thread_id"] = "user:" + ctx.userID;
      form["author"] = "fbid:" + ctx.userID;
      form["mentions[0]"] = JSON.stringify(message.mentions);
    }

    handleUrl(message, form, messageAndOTID, callback);
  }

  function sendSticker(stickerID, threadID, callback) {
    var messageAndOTID = utils.generateOfflineThreadingID();

    var form = {
      "sticker_id": stickerID,
      "client": "mercury",
      "message_batch[0][action_type]": "ma-type:user-generated-message",
      "message_batch[0][author]": "fbid:" + ctx.userID,
      "message_batch[0][thread_id]": threadID,
      "message_batch[0][source]": "source:chat:web",
      "message_batch[0][offline_threading_id]": messageAndOTID,
      "message_batch[0][timestamp]": utils.getTimestamp(),
    };

    sendContent(form, threadID, false, messageAndOTID, callback);
  }

  function sendEmoji(emoji, emojiSize, threadID, callback) {
    var messageAndOTID = utils.generateOfflineThreadingID();

    var form = {
      "emoji_choice": emoji,
      "emoji_size": emojiSize,
      "client": "mercury",
      "message_batch[0][action_type]": "ma-type:user-generated-message",
      "message_batch[0][author]": "fbid:" + ctx.userID,
      "message_batch[0][thread_id]": threadID,
      "message_batch[0][source]": "source:chat:web",
      "message_batch[0][offline_threading_id]": messageAndOTID,
      "message_batch[0][timestamp]": utils.getTimestamp(),
    };

    sendContent(form, threadID, false, messageAndOTID, callback);
  }

  function sendAttachment(attachment, threadID, callback) {
    var messageAndOTID = utils.generateOfflineThreadingID();

    if (!Array.isArray(attachment)) {
      attachment = [attachment];
    }

    uploadAttachment(attachment, function (err, attachments) {
      if (err) {
        return callback(err);
      }

      var form = {
        "client": "mercury",
        "message_batch[0][action_type]": "ma-type:user-generated-message",
        "message_batch[0][author]": "fbid:" + ctx.userID,
        "message_batch[0][thread_id]": threadID,
        "message_batch[0][source]": "source:chat:web",
        "message_batch[0][offline_threading_id]": messageAndOTID,
        "message_batch[0][timestamp]": utils.getTimestamp(),
        "message_batch[0][has_attachment]": true,
      };

      for (var i = 0; i < attachments.length; i++) {
        form[
          "message_batch[0][attachment][fbid_" + attachments[i].type + "]"
        ] = attachments[i].ID;
        form[
          "message_batch[0][attachment][filename_" + attachments[i].type + "]"
        ] = attachments[i].filename;
        form[
          "message_batch[0][attachment][filetype_" + attachments[i].type + "]"
        ] = attachments[i].filetype;
        form[
          "message_batch[0][attachment][filesize_" + attachments[i].type + "]"
        ] = attachments[i].filesize;
        form[
          "message_batch[0][attachment][creation_timestamp_" +
            attachments[i].type +
            "]"
        ] = attachments[i].creationTimestamp;
      }

      sendContent(form, threadID, false, messageAndOTID, callback);
    });
  }

  function sendURL(url, threadID, callback) {
    var messageAndOTID = utils.generateOfflineThreadingID();

    var form = {
      "shareable_attachment[share_type]": "100",
      "shareable_attachment[share_params][canonical100_url]": url,
      "shareable_attachment[share_params][description100_text]": "",
      "shareable_attachment[share_params][title]": "",
      "shareable_attachment[share_params][url]": url,
      "client": "mercury",
      "message_batch[0][action_type]": "ma-type:user-generated-message",
      "message_batch[0][author]": "fbid:" + ctx.userID,
      "message_batch[0][thread_id]": threadID,
      "message_batch[0][source]": "source:chat:web",
      "message_batch[0][offline_threading_id]": messageAndOTID,
      "message_batch[0][timestamp]": utils.getTimestamp(),
    };

    sendContent(form, threadID, false, messageAndOTID, callback);
  }

  function sendLocation(location, threadID, callback) {
    var messageAndOTID = utils.generateOfflineThreadingID();

    var form = {
      "coordinates": JSON.stringify(location),
      "client": "mercury",
      "message_batch[0][action_type]": "ma-type:user-generated-message",
      "message_batch[0][author]": "fbid:" + ctx.userID,
      "message_batch[0][thread_id]": threadID,
      "message_batch[0][source]": "source:chat:web",
      "message_batch[0][offline_threading_id]": messageAndOTID,
      "message_batch[0][timestamp]": utils.getTimestamp(),
    };

    sendContent(form, threadID, false, messageAndOTID, callback);
  }

  return function (message, callback) {
    if (!callback) {
      callback = function () { };
    }

    try {
      send(message, callback);
    } catch (e) {
      log.error("Error in sendApi", e);
      callback(e);
    }
  };
};
