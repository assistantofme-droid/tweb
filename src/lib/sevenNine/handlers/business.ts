/*
 * Business profile (opening hours, location, intro, greeting / away messages)
 * and quick replies.
 */

import type {
  BusinessRecipients,
  InputBusinessRecipients,
  InputMedia,
  InputQuickReplyShortcut,
  InputSingleMedia,
  Message,
  QuickReply,
  Update,
  UserFull
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import {RestException, restError, tlError} from '@lib/sevenNine/errors';
import {idFromMongoId, isMongoId} from '@lib/sevenNine/ids';
import {jsonStr} from '@lib/sevenNine/restBridge';

function recipientsFromJson(o: Json): BusinessRecipients.businessRecipients {
  const recipients: BusinessRecipients.businessRecipients = {_: 'businessRecipients', pFlags: {}};
  if(!o) return recipients;
  if(o.existingChats) recipients.pFlags.existing_chats = true;
  if(o.newChats) recipients.pFlags.new_chats = true;
  if(o.contacts) recipients.pFlags.contacts = true;
  if(o.nonContacts) recipients.pFlags.non_contacts = true;
  if(o.excludeSelected) recipients.pFlags.exclude_selected = true;
  const users = (Array.isArray(o.users) ? o.users : []).map(String).filter(isMongoId).map(idFromMongoId);
  if(users.length) recipients.users = users;
  return recipients;
}

/** userJson.business -> userFull.business_* */
export function applyBusinessInfo(b: RestBridge, full: UserFull.userFull, business: Json) {
  if(!business) return;
  const hours: Json = business.workHours;
  if(Array.isArray(hours?.weekly) && hours.weekly.length) {
    full.business_work_hours = {
      _: 'businessWorkHours',
      pFlags: {},
      timezone_id: String(hours.timezone || 'Asia/Tehran'),
      weekly_open: hours.weekly.map((p: Json) => ({
        _: 'businessWeeklyOpen',
        start_minute: +p.start || 0,
        end_minute: +p.end || 0
      }))
    };
  }

  const location: Json = business.location;
  if(jsonStr(location, 'address')) {
    full.business_location = {
      _: 'businessLocation',
      address: String(location.address),
      ...('lat' in location && 'lng' in location ? {
        geo_point: {_: 'geoPoint', lat: +location.lat, long: +location.lng, access_hash: '0'}
      } : {})
    };
  }

  const greeting: Json = business.greeting;
  if(+greeting?.shortcutId > 0) {
    full.business_greeting_message = {
      _: 'businessGreetingMessage',
      shortcut_id: +greeting.shortcutId,
      no_activity_days: +greeting.noActivityDays || 7,
      recipients: recipientsFromJson(greeting.recipients)
    };
  }

  const away: Json = business.away;
  if(+away?.shortcutId > 0) {
    full.business_away_message = {
      _: 'businessAwayMessage',
      pFlags: away.offlineOnly ? {offline_only: true} : {},
      shortcut_id: +away.shortcutId,
      schedule: away.schedule === 'outside_hours' ? {_: 'businessAwayMessageScheduleOutsideWorkHours'} :
        away.schedule === 'custom' ? {_: 'businessAwayMessageScheduleCustom', start_date: +away.start || 0, end_date: +away.end || 0} :
        {_: 'businessAwayMessageScheduleAlways'},
      recipients: recipientsFromJson(away.recipients)
    };
  }

  const intro: Json = business.intro;
  if(intro && (jsonStr(intro, 'title') || jsonStr(intro, 'description'))) {
    const sticker = jsonStr(intro, 'stickerUrl');
    full.business_intro = {
      _: 'businessIntro',
      title: String(intro.title || ''),
      description: String(intro.description || ''),
      ...(sticker ? {sticker: b.buildDocument(b.absoluteUrl(sticker), 'image/webp', 'sticker.webp', 'sticker')} : {})
    };
  }
}

export default function businessHandlers(b: RestBridge): BridgeHandlers {
  const recipientsToJson = (r: InputBusinessRecipients) => {
    const pFlags = r?.pFlags || {};
    return {
      existingChats: !!pFlags.existing_chats,
      newChats: !!pFlags.new_chats,
      contacts: !!pFlags.contacts,
      nonContacts: !!pFlags.non_contacts,
      excludeSelected: !!pFlags.exclude_selected,
      users: (r?.users || []).map((u) => b.userMongoIdOf(u)).filter(Boolean)
    };
  };

  const saveSettings = async(body: Json) => {
    try {
      await b.http.request('PUT', '/business/settings', body);
    } catch(err) {
      if(err instanceof RestException) {
        throw tlError(err.statusCode === 403 ? 403 : 400, err.statusCode === 403 ? 'PREMIUM_ACCOUNT_REQUIRED' : 'SHORTCUT_INVALID');
      }

      throw err;
    }

    return true;
  };

  const buildQuickReply = (q: Json): QuickReply.quickReply => ({
    _: 'quickReply',
    shortcut_id: +q.shortcutId || 0,
    shortcut: String(q.shortcut || ''),
    count: +q.count || 0,
    top_message: +q.top?.id || 0
  });

  const buildQuickReplyMessage = (m: Json, shortcutId: number): Message.message => {
    const id = +m.id || 0;
    const json: Json = {
      ...m,
      _id: ('000000000000000000000000' + id.toString(16)).slice(-24),
      sender: b.selfMongoId
    };

    if(jsonStr(m, 'editedAt')) {
      json.isEdited = true;
      json.updatedAt = m.editedAt;
    }

    const message = b.buildMessage(json, {_: 'peerUser', user_id: b.selfTlId});
    message.id = id;
    message.pFlags.out = true;
    delete message.pFlags.unread;
    delete message.pFlags.media_unread;
    message.quick_reply_shortcut_id = shortcutId;
    return message;
  };

  const shortcutTarget = (shortcut: InputQuickReplyShortcut): Json => {
    return shortcut._ === 'inputQuickReplyShortcutId' ?
      {shortcutId: shortcut.shortcut_id} :
      {shortcut: shortcut.shortcut};
  };

  const quickReplyCall = async(method: string, path: string, body?: Json) => {
    try {
      const response = await b.http.request(method, path, body);
      return !('ok' in response) || !!response.ok;
    } catch(err) {
      if(err instanceof RestException) {
        throw tlError(400, /^[A-Z_]+$/.test(err.serverMessage || '') ? err.serverMessage : 'SHORTCUT_INVALID');
      }

      throw err;
    }
  };

  /** messages sent into a quick reply shortcut (not a chat) */
  const sendToQuickReply = async(shortcut: InputQuickReplyShortcut, items: {media?: InputMedia, message: string, entities?: InputSingleMedia['entities'], random_id: string | number}[]) => {
    let target = shortcutTarget(shortcut);
    const updates: Update[] = [];
    let lastSummary: Json;
    for(const item of items) {
      let response: Json;
      try {
        if(!item.media || item.media._ === 'inputMediaEmpty' || item.media._ === 'inputMediaWebPage') {
          const body: Json = {...target, type: 'text', text: item.message || ''};
          const formatting = b.entitiesToJson(item.entities);
          if(formatting.length) body.entities = formatting;
          response = await b.http.request('POST', '/business/quick-replies/messages', body);
        } else {
          response = await b.sendMediaMessage(undefined, item.media, item.message, undefined, item.entities, target);
        }
      } catch(err) {
        if(err instanceof RestException) {
          throw tlError(400, /^[A-Z_]+$/.test(err.serverMessage || '') ? err.serverMessage : 'MESSAGE_EMPTY');
        }

        throw err;
      }

      lastSummary = response.quickReply;
      const shortcutId = +lastSummary?.shortcutId || 0;
      // later items go to the (possibly just created) shortcut by id
      target = {shortcutId};
      const message = buildQuickReplyMessage(response.message || {}, shortcutId);
      updates.push({_: 'updateMessageID', id: message.id, random_id: item.random_id});
      updates.push({_: 'updateQuickReplyMessage', message});
    }

    if(lastSummary) {
      updates.push({_: 'updateNewQuickReply', quick_reply: buildQuickReply(lastSummary)});
    }

    return b.emptyUpdates([], [], updates);
  };

  b.sendToQuickReply = sendToQuickReply;

  return {
    'account.updateBusinessWorkHours': ({business_work_hours: hours}) => saveSettings({
      workHours: hours ? {
        timezone: hours.timezone_id,
        weekly: hours.weekly_open.map((o) => ({start: o.start_minute, end: o.end_minute}))
      } : null
    }),

    'account.updateBusinessLocation': ({address, geo_point}) => saveSettings({
      location: address ? {
        address,
        ...(geo_point?._ === 'inputGeoPoint' ? {lat: geo_point.lat, lng: geo_point.long} : {})
      } : null
    }),

    'account.updateBusinessIntro': ({intro}) => {
      if(!intro) return saveSettings({intro: null});
      const stickerId = (intro.sticker as {id: string | number})?.id;
      const stickerUrl = stickerId ? b.relativeUploadPath(b.getMediaUrl(stickerId)) : undefined;
      return saveSettings({
        intro: {
          title: intro.title || '',
          description: intro.description || '',
          ...(stickerUrl ? {stickerUrl} : {})
        }
      });
    },

    'account.updateBusinessGreetingMessage': ({message}) => saveSettings({
      greeting: message ? {
        shortcutId: message.shortcut_id,
        noActivityDays: message.no_activity_days,
        recipients: recipientsToJson(message.recipients)
      } : null
    }),

    'account.updateBusinessAwayMessage': ({message}) => {
      if(!message) return saveSettings({away: null});
      const schedule = message.schedule;
      return saveSettings({
        away: {
          shortcutId: message.shortcut_id,
          offlineOnly: !!message.pFlags?.offline_only,
          ...(schedule._ === 'businessAwayMessageScheduleOutsideWorkHours' ? {schedule: 'outside_hours'} :
            schedule._ === 'businessAwayMessageScheduleCustom' ? {schedule: 'custom', start: schedule.start_date, end: schedule.end_date} :
            {schedule: 'always'}),
          recipients: recipientsToJson(message.recipients)
        }
      });
    },

    // ---------------------------------------------------------------- quick replies
    'messages.getQuickReplies': async() => {
      const list = await b.http.requestArray('GET', '/business/quick-replies').catch((): Json[] => []);
      const quickReplies: QuickReply[] = [];
      const messages: Message[] = [];
      for(const q of list) {
        const reply = buildQuickReply(q);
        quickReplies.push(reply);
        if(q.top) messages.push(buildQuickReplyMessage(q.top, reply.shortcut_id));
      }

      return {_: 'messages.quickReplies', quick_replies: quickReplies, messages, chats: [], users: []};
    },

    'messages.getQuickReplyMessages': async({shortcut_id, id}) => {
      const query = id?.length ? '?ids=' + id.join(',') : '';
      const response = await b.http.request('GET', '/business/quick-replies/' + shortcut_id + '/messages' + query).catch((): Json => ({}));
      const messages = (Array.isArray(response.messages) ? response.messages : [])
      .map((m: Json) => buildQuickReplyMessage(m, shortcut_id))
      .reverse(); // newest first
      return {_: 'messages.messages', messages, topics: [], chats: [], users: []};
    },

    'messages.deleteQuickReplyMessages': async({shortcut_id, id}) => {
      const updates: Update[] = [];
      try {
        const response = await b.http.request('POST', '/business/quick-replies/' + shortcut_id + '/messages/delete', {ids: id});
        updates.push({_: 'updateDeleteQuickReplyMessages', shortcut_id, messages: id});
        if(response.deleted) updates.push({_: 'updateDeleteQuickReply', shortcut_id});
      } catch(err) {}

      return b.emptyUpdates([], [], updates);
    },

    // re-send the shortcut's messages into the chat (media is reused, not uploaded again)
    'messages.sendQuickReplyMessages': async({peer, shortcut_id, id}) => {
      const query = id?.length ? '?ids=' + id.join(',') : '';
      const response = await b.http.request('GET', '/business/quick-replies/' + shortcut_id + '/messages' + query);
      for(const m of Array.isArray(response.messages) ? response.messages : []) {
        const body: Json = {type: m.type || 'text'};
        await b.putMessageTarget(body, peer);
        if(jsonStr(m, 'text')) body.text = m.text;
        if(Array.isArray(m.entities)) body.entities = m.entities;
        if(jsonStr(m, 'fileUrl')) {
          body.existingFileUrl = m.fileUrl;
          if(jsonStr(m, 'fileName')) body.fileName = m.fileName;
        }

        if(m.location) body.location = m.location;
        if(m.mediaMeta) body.mediaMeta = m.mediaMeta;
        if(m.hasSpoiler) body.hasSpoiler = true;
        try {
          const sent = await b.http.request('POST', '/messages', body);
          b.rememberSentConversation(peer, sent);
        } catch(err) {
          throw err instanceof RestException ? restError(err.statusCode, err.serverMessage) : err;
        }
      }

      // the messages arrive over the socket like any other sent message
      return b.emptyUpdates();
    },

    'messages.deleteQuickReplyShortcut': ({shortcut_id}) => quickReplyCall('DELETE', '/business/quick-replies/' + shortcut_id),
    'messages.editQuickReplyShortcut': ({shortcut_id, shortcut}) => quickReplyCall('PUT', '/business/quick-replies/' + shortcut_id, {shortcut}),
    'messages.reorderQuickReplies': ({order}) => quickReplyCall('POST', '/business/quick-replies/reorder', {order}),
    'messages.checkQuickReplyShortcut': ({shortcut}) => quickReplyCall('GET', '/business/quick-replies/check?shortcut=' + encodeURIComponent(shortcut || '')).catch(() => false),

    'account.getBusinessChatLinks': () => ({_: 'account.businessChatLinks', links: [], chats: [], users: []})
  };
}
