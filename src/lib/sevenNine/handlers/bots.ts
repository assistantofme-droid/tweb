/*
 * Bots: /start, callback buttons, inline mode, mini apps, games, and the
 * owner editing a bot (name, about, photo).
 *
 *   POST /messages/callback_query_answer    a callback button
 *   POST /botapi/inline/query, /send        "@bot query" and picking a result
 *   POST /messages/webapp, /webapp-data     mini app launch url, sendData()
 *   GET  /messages/:id/game-scores
 *   PUT  /botapi/my/:botId                   name / about / description / photo
 */

import type {
  BotInlineMessage,
  BotInlineResult,
  InputFile,
  InputPeer,
  InputUser,
  MessagesBotResults,
  Photo,
  User
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import {RestException, restError, tlError} from '@lib/sevenNine/errors';
import {idForUrl} from '@lib/sevenNine/ids';
import {EXTENSION_BY_MIME} from '@lib/sevenNine/handlers/files';
import {jsonStr} from '@lib/sevenNine/restBridge';

const MEDIA_RESULT_TYPES = ['photo', 'gif', 'mpeg4_gif', 'sticker'];

function firstNonEmpty(r: Json, ...keys: string[]) {
  for(const key of keys) {
    const v = jsonStr(r, key);
    if(v && v !== 'null') return v;
  }

  return '';
}

function utf8Decode(bytes: Uint8Array) {
  return bytes ? new TextDecoder().decode(bytes) : '';
}

export default function botsHandlers(b: RestBridge): BridgeHandlers {
  // the backend's inline query ids are strings: TL wants a number
  const inlineQueryIdByTl: Map<string, string> = new Map();

  const requireBotMongoId = (bot: InputUser) => {
    const botId = bot && b.userMongoIdOf(bot);
    if(!botId) throw tlError(400, 'BOT_INVALID');
    return botId;
  };

  const optionalConversationId = async(peer: InputPeer) => {
    if(!peer || peer._ === 'inputPeerEmpty') return undefined;
    return b.conversationIdOf(peer).catch((): string => undefined);
  };

  // Bot API file_id ("F" + base64url(/uploads/...)) or url -> absolute url
  const fileRefToUrl = (ref: string) => {
    if(/^https?:\/\//.test(ref)) return ref;
    if(ref.startsWith('F')) {
      try {
        const base64 = ref.slice(1).replace(/-/g, '+').replace(/_/g, '/');
        const path = atob(base64 + '==='.slice((base64.length + 3) % 4));
        if(path.startsWith('/uploads/')) return b.absoluteUrl(path);
      } catch(err) {}
    }

    return b.absoluteUrl(ref);
  };

  const buildInlineResult = (r: Json): BotInlineResult => {
    const type = jsonStr(r, 'type') || 'article';
    const id = jsonStr(r, 'id');
    if(!id) return;

    const replyMarkup = r.reply_markup ? b.buildReplyMarkup(r.reply_markup) : undefined;
    const content: Json = r.input_message_content;
    let send: BotInlineMessage;
    if(content && content.message_text !== undefined) {
      send = {
        _: 'botInlineMessageText',
        pFlags: content.link_preview_options?.is_disabled ? {no_webpage: true} : {},
        message: String(content.message_text || '')
      };
    } else if((content && content.latitude !== undefined) || type === 'location' || type === 'venue') {
      const src = content && content.latitude !== undefined ? content : r;
      send = {
        _: 'botInlineMessageMediaGeo',
        geo: {_: 'geoPoint', lat: +src.latitude || 0, long: +src.longitude || 0, access_hash: 0}
      };
    } else {
      send = {_: 'botInlineMessageMediaAuto', pFlags: {}, message: jsonStr(r, 'caption') || ''};
    }

    if(replyMarkup) send.reply_markup = replyMarkup;

    const title = jsonStr(r, 'title');
    const description = jsonStr(r, 'description');
    const texts = {...(title ? {title} : {}), ...(description ? {description} : {})};

    const photoUrl = firstNonEmpty(r, 'photo_url', 'photo_file_id');
    if(type === 'photo' && photoUrl) {
      return {_: 'botInlineMediaResult', id, type: 'photo', photo: b.buildPhoto(fileRefToUrl(photoUrl), {}), ...texts, send_message: send};
    }

    const mediaUrl = firstNonEmpty(r, 'gif_url', 'mpeg4_url', 'video_url', 'audio_url', 'voice_url', 'document_url',
      'gif_file_id', 'mpeg4_file_id', 'video_file_id', 'audio_file_id', 'voice_file_id', 'document_file_id', 'sticker_file_id');
    if(mediaUrl && type !== 'article') {
      const kind = type === 'gif' || type === 'mpeg4_gif' ? 'gif' :
        type === 'sticker' || type === 'video' || type === 'audio' || type === 'voice' ? type :
        'file';
      const mime = kind === 'gif' || kind === 'video' ? 'video/mp4' :
        kind === 'sticker' ? 'image/webp' :
        kind === 'audio' ? 'audio/mpeg' :
        kind === 'voice' ? 'audio/ogg' :
        jsonStr(r, 'mime_type') || 'application/octet-stream';
      return {
        _: 'botInlineMediaResult',
        id,
        type: type === 'mpeg4_gif' ? 'gif' : type,
        document: b.buildDocument(fileRefToUrl(mediaUrl), mime, title || undefined, kind),
        ...texts,
        send_message: send
      };
    }

    const url = jsonStr(r, 'url');
    const thumb = jsonStr(r, 'thumbnail_url') || jsonStr(r, 'thumb_url');
    return {
      _: 'botInlineResult',
      id,
      type: type === 'venue' ? 'venue' : type === 'location' ? 'geo' : 'article',
      ...texts,
      ...(url ? {url} : {}),
      ...(thumb ? {thumb: {_: 'webDocumentNoProxy', url: fileRefToUrl(thumb), size: 0, mime_type: 'image/jpeg', attributes: []}} : {}),
      send_message: send
    };
  };

  const sentMessageUpdates = (sent: Json, peer: InputPeer, randomId: string | number) => {
    b.rememberSentConversation(peer, sent);
    const message = b.buildAnyMessage(sent, b.peerFromInput(peer));
    const users: User[] = [];
    b.addSender(sent, users);
    return b.emptyUpdates(users, [], [
      {_: 'updateMessageID', id: message.id, random_id: randomId},
      b.newMessageUpdate(message)
    ]);
  };

  const requestWebApp = async(options: {
    bot: InputUser,
    kind: string,
    url?: string,
    peer?: InputPeer,
    startParam?: string,
    themeParams?: string
  }) => {
    const body: Json = {botId: requireBotMongoId(options.bot), kind: options.kind};
    if(options.url) body.url = options.url;
    if(options.startParam) body.startParam = options.startParam;
    if(options.themeParams) {
      try {
        body.themeParams = JSON.parse(options.themeParams);
      } catch(err) {}
    }

    const convId = await optionalConversationId(options.peer);
    if(convId) body.conversationId = convId;

    let response: Json;
    try {
      response = await b.http.request('POST', '/messages/webapp', body);
    } catch(err) {
      if(err instanceof RestException) {
        throw tlError(400, 'WEBAPP_' + (err.serverMessage || 'ERROR').replace(/ /g, '_').toUpperCase());
      }

      throw err;
    }

    return {
      _: 'webViewResultUrl' as const,
      pFlags: {},
      query_id: idForUrl('webapp:' + (jsonStr(response, 'query_id') || '')),
      url: String(response.url)
    };
  };

  const setBotPhoto = async(bot: InputUser, file: InputFile) => {
    const botId = requireBotMongoId(bot);
    try {
      if(file) {
        const blob = b.takeUpload(file, 'image/jpeg');
        const mime = blob.type || 'image/jpeg';
        await b.http.requestMultipart('PUT', '/botapi/my/' + botId, {}, [{field: 'photo', blob, fileName: 'bot' + (EXTENSION_BY_MIME[mime] || '.jpg')}]);
      } else {
        await b.http.request('PUT', '/botapi/my/' + botId, {removePhoto: true});
      }
    } catch(err) {
      if(err instanceof RestException) throw tlError(400, 'BOT_INVALID');
      throw err;
    }

    const user = await b.http.request('GET', '/auth/users/' + botId);
    const avatar = jsonStr(user, 'avatar');
    const photo: Photo = avatar ? b.buildProfilePhoto(avatar) : {_: 'photoEmpty', id: '0'};
    return {_: 'photos.photo' as const, photo, users: [b.buildUser(user)]};
  };

  b.setBotPhoto = setBotPhoto;

  return {
    // the START button: "/start" (plus the deep-link parameter) to the bot
    'messages.startBot': async({peer, start_param, random_id}) => {
      const body: Json = {text: '/start' + (start_param ? ' ' + start_param : ''), type: 'text'};
      await b.putMessageTarget(body, peer);
      const sent = await b.http.request('POST', '/messages', body).catch((err) => {
        throw err instanceof RestException ? restError(err.statusCode, err.serverMessage) : err;
      });
      return sentMessageUpdates(sent, peer, random_id);
    },

    'messages.getBotCallbackAnswer': async({peer, msg_id, data, game}) => {
      const answer = {_: 'messages.botCallbackAnswer' as const, pFlags: {} as {alert?: true, has_url?: true}, cache_time: 0, message: undefined as string, url: undefined as string};
      try {
        const convId = await b.requireConversationIdOf(peer);
        const body: Json = {conversationId: convId, callbackData: utf8Decode(data)};
        const messageMongoId = await b.getMessageMongoId(msg_id);
        if(messageMongoId) body.messageId = messageMongoId;
        if(game) {
          const shortName = b.gameShortNameByMsg.get(msg_id);
          if(shortName) body.gameShortName = shortName;
        }

        const response = await b.http.request('POST', '/messages/callback_query_answer', body);
        const text = jsonStr(response, 'text') || jsonStr(response, 'answer');
        if(text) {
          answer.message = text;
          if(response.show_alert) answer.pFlags.alert = true;
        }

        const url = jsonStr(response, 'url');
        if(url) {
          answer.url = url;
          answer.pFlags.has_url = true;
        }
      } catch(err) {}

      if(answer.message === undefined) delete answer.message;
      if(answer.url === undefined) delete answer.url;
      return answer;
    },

    'messages.getInlineBotResults': async({bot, peer, query, offset}) => {
      const body: Json = {bot: requireBotMongoId(bot), query: query || '', offset: offset || ''};
      const convId = await optionalConversationId(peer);
      if(convId) body.conversationId = convId;

      let response: Json;
      try {
        response = await b.http.request('POST', '/botapi/inline/query', body);
      } catch(err) {
        if(err instanceof RestException) {
          throw tlError(400, /^[A-Z_]+$/.test(err.serverMessage || '') ? err.serverMessage : 'BOT_RESPONSE_TIMEOUT');
        }

        throw err;
      }

      const queryId = jsonStr(response, 'queryId') || '0';
      const tlQueryId = /^\d{1,15}$/.test(queryId) ? queryId : String(idForUrl('inline:' + queryId));
      inlineQueryIdByTl.set(tlQueryId, queryId);

      const result: MessagesBotResults.messagesBotResults = {
        _: 'messages.botResults',
        pFlags: {},
        query_id: tlQueryId,
        results: [],
        cache_time: +response.cacheTime || 0,
        users: []
      };

      const next = jsonStr(response, 'nextOffset');
      if(next && next !== 'null') result.next_offset = next;

      const button: Json = response.button;
      if(button && jsonStr(button, 'text')) {
        const webAppUrl = jsonStr(button.web_app || {}, 'url');
        if(webAppUrl) {
          result.switch_webview = {_: 'inlineBotWebView', text: String(button.text), url: webAppUrl};
        } else {
          result.switch_pm = {_: 'inlineBotSwitchPM', text: String(button.text), start_param: jsonStr(button, 'start_parameter') || ''};
        }
      }

      const results: Json[] = response.results || [];
      let allMedia = results.length > 0;
      for(const r of results) {
        const item = r && buildInlineResult(r);
        if(!item) continue;
        if(!MEDIA_RESULT_TYPES.includes(jsonStr(r, 'type') || 'article')) allMedia = false;
        result.results.push(item);
      }

      if(allMedia) result.pFlags.gallery = true;
      return result;
    },

    'messages.sendInlineBotResult': async({peer, query_id, id, random_id, reply_to}) => {
      const body: Json = {
        queryId: inlineQueryIdByTl.get(String(query_id)) || String(query_id),
        resultId: id
      };
      await b.putMessageTarget(body, peer);
      if(reply_to?._ === 'inputReplyToMessage' && reply_to.reply_to_msg_id) {
        const replyMongoId = await b.getMessageMongoId(reply_to.reply_to_msg_id);
        if(replyMongoId) body.replyTo = replyMongoId;
      }

      const sent = await b.http.request('POST', '/botapi/inline/send', body).catch((err) => {
        throw err instanceof RestException ? restError(err.statusCode, err.serverMessage) : err;
      });
      return sentMessageUpdates(sent, peer, random_id);
    },

    // ---------------------------------------------------------------- mini apps
    'messages.requestWebView': (params) => requestWebApp({
      bot: params.bot,
      kind: params.from_bot_menu ? 'menu' : 'inline',
      url: params.url,
      peer: params.peer,
      startParam: params.start_param,
      themeParams: params.theme_params?.data
    }),

    'messages.requestSimpleWebView': (params) => requestWebApp({
      bot: params.bot,
      kind: 'simple',
      url: params.url,
      startParam: params.start_param,
      themeParams: params.theme_params?.data
    }),

    'messages.requestMainWebView': (params) => requestWebApp({
      bot: params.bot,
      kind: 'main',
      peer: params.peer,
      startParam: params.start_param,
      themeParams: params.theme_params?.data
    }),

    'messages.prolongWebView': () => true,

    // Telegram.WebApp.sendData() from a keyboard web app
    'messages.sendWebViewData': async({bot, button_text, data}) => {
      const botId = bot && b.userMongoIdOf(bot);
      if(botId) {
        await b.http.request('POST', '/messages/webapp-data', {botId, buttonText: button_text || '', data: data || ''});
      }

      return b.emptyUpdates();
    },

    // ---------------------------------------------------------------- games
    'messages.getGameHighScores': async({id}) => {
      const result = {_: 'messages.highScores' as const, scores: [] as {_: 'highScore', pos: number, user_id: number, score: number}[], users: [] as User[]};
      try {
        const mongoId = await b.getMessageMongoId(id);
        if(!mongoId) return result;
        const rows = await b.http.requestArray('GET', '/messages/' + mongoId + '/game-scores');
        rows.forEach((row, i) => {
          const userJson: Json = row.user;
          if(!userJson?._id) return;
          const user = b.buildUser(userJson);
          b.addUserOnce(result.users, user);
          result.scores.push({_: 'highScore', pos: +row.position || i + 1, user_id: +user.id, score: +row.score || 0});
        });
      } catch(err) {}

      return result;
    },

    // ---------------------------------------------------------------- the owner editing a bot
    'bots.setBotInfo': async({bot, name, about, description}) => {
      const botId = requireBotMongoId(bot);
      const body: Json = {};
      if(name !== undefined) body.name = name;
      if(about !== undefined) body.about = about;
      if(description !== undefined) body.description = description;
      try {
        await b.http.request('PUT', '/botapi/my/' + botId, body);
      } catch(err) {
        if(err instanceof RestException) throw tlError(400, 'BOT_INVALID');
        throw err;
      }

      const user = await b.http.request('GET', '/auth/users/' + botId);
      b.usersManager.saveApiUsers([b.buildUser(user)]);
      return true;
    }
  };
}
