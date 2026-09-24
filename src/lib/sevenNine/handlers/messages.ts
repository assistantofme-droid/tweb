/*
 * Dialogs, history, sending / editing / deleting / forwarding messages,
 * reactions, read state, search and catch-up.
 */

import type {
  Chat,
  Dialog,
  InputMedia,
  InputPeer,
  InputReplyTo,
  Message,
  MessageEntity,
  MessagePeerReaction,
  MessagePeerVote,
  MessagesDialogs,
  MessagesFilter,
  MessagesMessages,
  Peer,
  Update,
  UpdatesDifference,
  User
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import tsNow from '@helpers/tsNow';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';
import {restError, RestException, tlError} from '@lib/sevenNine/errors';
import {idFromMongoId, idFromMongoIdInt32, isMongoId, parseIsoToEpochSeconds} from '@lib/sevenNine/ids';
import {idListContains, jsonStr, refId} from '@lib/sevenNine/restBridge';

const MAX_PAGE = 100;
// how far back "newer than offset" history loads may walk
const MAX_WALK_PAGES = 10;
// catch-up (getDifference) only replays this much
const MAX_DIFFERENCE_AGE = 7 * 86400;

type AnyMessage = Message.message | Message.messageService;

const REPORT_OPTIONS: [key: string, text: string][] = [
  ['spam', 'Spam'],
  ['violence', 'Violence'],
  ['pornography', 'Pornography'],
  ['child_abuse', 'Child abuse'],
  ['illegal', 'Illegal goods'],
  ['scam', 'Scam or fraud'],
  ['other', 'Other']
];

function isReadByOthers(m: Json, selfMongoId: string) {
  if(!m) return false;
  if(m.isRead === true || m.seen === true || m.status === 'read' || m.status === 'seen') return true;
  const readBy = m.readBy || m.seenBy;
  if(Array.isArray(readBy)) {
    return readBy.some((r: any) => {
      const id = r && typeof(r) === 'object' ? String(r.user?._id ?? r.user ?? r.userId ?? r._id) : String(r);
      return id && id !== selfMongoId;
    });
  }

  return false;
}

function searchFilterName(filter: MessagesFilter) {
  switch(filter?._) {
    case 'inputMessagesFilterPhotos': return 'photo';
    case 'inputMessagesFilterPhotoVideo': return 'photovideo';
    case 'inputMessagesFilterVideo': return 'video';
    case 'inputMessagesFilterDocument': return 'file';
    case 'inputMessagesFilterMusic': return 'music';
    case 'inputMessagesFilterVoice':
    case 'inputMessagesFilterRoundVoice': return 'voice';
    case 'inputMessagesFilterUrl': return 'url';
    case 'inputMessagesFilterGif': return 'gif';
    case 'inputMessagesFilterGeo': return 'location';
    case 'inputMessagesFilterRoundVideo': return 'none';
    default: return '';
  }
}

export default function messagesHandlers(b: RestBridge): BridgeHandlers {
  const isMutedByMe = (conv: Json) => idListContains(conv.mutedBy, b.selfMongoId) ||
    !!(conv.mutedUntil && b.selfMongoId && conv.mutedUntil[b.selfMongoId]);

  const selfCount = (map: Json) => (map && b.selfMongoId ? +map[b.selfMongoId] || 0 : 0);

  /** one conversation JSON -> dialog (+ its users / chats / top message) */
  const buildDialog = (conv: Json, result: {dialogs: Dialog[], messages: Message[], users: User[], chats: Chat[]}, folderId?: number) => {
    const peer = b.registerConversation(conv, result.users, result.chats);
    if(!peer) return undefined;
    const convId = String(conv._id);
    // needed to receive typing / room events for this chat
    b.socket.joinConversation(convId);

    const unreadCount = selfCount(conv.unreadCount);
    const dialog: Dialog.dialog = {
      _: 'dialog',
      pFlags: {},
      peer,
      top_message: 0,
      read_inbox_max_id: 0,
      read_outbox_max_id: 0,
      unread_count: unreadCount,
      unread_mentions_count: Math.min(selfCount(conv.unreadMentions), unreadCount),
      unread_reactions_count: 0,
      unread_poll_votes_count: 0,
      notify_settings: {
        _: 'peerNotifySettings',
        ...(isMutedByMe(conv) ? {mute_until: 0x7FFFFFFF} : {})
      }
    };

    if(peer._ === 'peerChannel') {
      dialog.pts = 1;
      b.ensureChannelState(+peer.channel_id);
    }

    if(folderId) dialog.folder_id = 1;

    const lastMessage: Json = conv.lastMessage && typeof(conv.lastMessage) === 'object' ? conv.lastMessage : undefined;
    if(lastMessage?._id) {
      const message = b.buildAnyMessage(lastMessage, peer);
      b.addSender(lastMessage, result.users);
      result.messages.push(message);
      dialog.top_message = message.id;
      // unknown exact positions: everything read unless the badge says otherwise
      dialog.read_inbox_max_id = unreadCount ? 0 : message.id;
      const out = message.pFlags.out;
      dialog.read_outbox_max_id = !out || isReadByOthers(lastMessage, b.selfMongoId) ? message.id : Math.max(0, message.id - 1);
    }

    result.dialogs.push(dialog);
    return dialog;
  };

  const getDialogs = async(folderId: number): Promise<MessagesDialogs.messagesDialogs> => {
    const conversations = await b.http.requestArray('GET', '/messages/conversations');
    const result: MessagesDialogs.messagesDialogs = {_: 'messages.dialogs', dialogs: [], messages: [], chats: [], users: []};
    for(const conv of conversations) {
      const archived = idListContains(conv.archivedBy, b.selfMongoId);
      if(archived !== (folderId === 1)) {
        // still register the peer: realtime events may arrive for it
        b.registerConversation(conv, [], []);
        continue;
      }

      buildDialog(conv, result, folderId);
    }

    return result;
  };

  /**
   * Backend history is newest-page + "before <id>" paging (oldest first in
   * each page). TL wants [offset_id, add_offset, limit] windows, newest first.
   */
  const fetchPage = (convId: string, limit: number, beforeMongoId?: string) => {
    let path = '/messages/' + convId + '?page=1&limit=' + Math.max(1, Math.min(limit, MAX_PAGE));
    if(beforeMongoId) path += '&before=' + beforeMongoId;
    return b.http.requestArray('GET', path);
  };

  const getHistoryJson = async(convId: string, offsetId: number, addOffset: number, limit: number): Promise<Json[]> => {
    limit = Math.max(1, Math.min(limit || 20, MAX_PAGE));
    offsetId = getServerMessageId(offsetId || 0);

    if(!offsetId) {
      // newest messages (add_offset > 0 skips the newest ones)
      const skip = Math.max(0, addOffset);
      const page = await fetchPage(convId, Math.min(MAX_PAGE, limit + skip));
      return page.slice(0, Math.max(0, page.length - skip)).slice(-limit);
    }

    const offsetMongoId = await b.getMessageMongoId(offsetId);
    if(!offsetMongoId) {
      return [];
    }

    const olderCount = addOffset < 0 ? limit + addOffset : limit;
    const newerCount = addOffset < 0 ? -addOffset : 0;
    const skip = Math.max(0, addOffset);

    let older: Json[] = [];
    if(olderCount > 0) {
      const page = await fetchPage(convId, Math.min(MAX_PAGE, olderCount + skip), offsetMongoId);
      older = page.slice(0, Math.max(0, page.length - skip)).slice(-olderCount);
    }

    if(!newerCount) {
      return older;
    }

    // "offset_id and newer": walk back from the newest page until offset_id is reached
    let newer: Json[] = [];
    let before: string;
    for(let i = 0; i < MAX_WALK_PAGES; ++i) {
      const page = await fetchPage(convId, MAX_PAGE, before);
      if(!page.length) break;
      newer = page.concat(newer);
      const oldestId = idFromMongoIdInt32(String(page[0]._id));
      if(oldestId <= offsetId || page.length < MAX_PAGE) break;
      before = String(page[0]._id);
    }

    newer = newer.filter((m) => idFromMongoIdInt32(String(m._id)) >= offsetId);
    newer = newer.slice(0, newerCount);
    return older.concat(newer);
  };

  const buildMessagesResult = (list: Json[], peer: Peer, count?: number): MessagesMessages.messagesMessagesSlice | MessagesMessages.messagesChannelMessages => {
    const users: User[] = [], chats: Chat[] = [];
    const messages: AnyMessage[] = list.map((m) => {
      b.addSender(m, users);
      return b.buildAnyMessage(m, peer);
    });
    messages.sort((a, b) => b.id - a.id); // newest first

    if(peer._ === 'peerChannel') {
      const channelId = +peer.channel_id;
      b.ensureChannelState(channelId);
      const chat = b.chatsManager.getChat(channelId);
      if(chat) chats.push(chat);
      return {
        _: 'messages.channelMessages',
        pFlags: {},
        pts: 1,
        count: count ?? messages.length,
        messages,
        topics: [],
        chats,
        users
      };
    }

    return {
      _: 'messages.messagesSlice',
      pFlags: {},
      count: count ?? messages.length,
      messages,
      topics: [],
      chats,
      users
    };
  };

  const putReplyTo = async(body: Json, replyTo: InputReplyTo) => {
    if(replyTo?._ !== 'inputReplyToMessage' || !replyTo.reply_to_msg_id) return;
    const replyMongoId = await b.getMessageMongoId(replyTo.reply_to_msg_id);
    if(replyMongoId) body.replyTo = replyMongoId;
    if(replyTo.top_msg_id && replyTo.top_msg_id !== replyTo.reply_to_msg_id) {
      const rootMongoId = await b.getMessageMongoId(replyTo.top_msg_id);
      if(rootMongoId) body.threadRoot = rootMongoId;
    }
  };

  const putMediaOptions = (body: Json, media: InputMedia, captionEntities: MessageEntity[]) => {
    const m = media as InputMedia.inputMediaUploadedPhoto;
    if(m.pFlags?.spoiler) body.hasSpoiler = true;
    if(m.ttl_seconds === 0x7FFFFFFF) body.selfDestructTimer = 'view_once';
    else if(m.ttl_seconds > 0) body.selfDestructTimer = String(m.ttl_seconds);
    const formatting = b.entitiesToJson(captionEntities);
    if(formatting.length) body.entities = formatting;
  };

  /** one media message -> the backend's sent message JSON */
  const sendOneMedia = async(
    peer: InputPeer,
    media: InputMedia,
    caption: string,
    replyTo: InputReplyTo,
    captionEntities: MessageEntity[],
    quickReplyTarget?: Json
  ): Promise<Json> => {
    // quick reply shortcuts take the same messages on their own path
    const path = quickReplyTarget ? '/business/quick-replies/messages' : '/messages';
    const body: Json = {...quickReplyTarget};
    if(!quickReplyTarget) await b.putMessageTarget(body, peer);
    await putReplyTo(body, replyTo);
    if(caption) body.text = caption;

    if(media._ === 'inputMediaDocument' || media._ === 'inputMediaPhoto') {
      // an existing file (saved GIF, sticker, re-send): reused by its URL
      const input = media.id as {id: string | number, file_reference?: Uint8Array | number[]};
      const url = b.getMediaUrl(input?.id) || b.urlFromFileReference(input?.file_reference);
      const path = b.relativeUploadPath(url);
      if(!path) throw tlError(400, 'MEDIA_INVALID');
      const doc = media._ === 'inputMediaDocument' ? b.docsManager.getDoc(input.id) : undefined;
      const lower = path.toLowerCase();
      body.type = media._ === 'inputMediaPhoto' ? 'image' :
        doc?.type === 'sticker' || lower.endsWith('.webp') || lower.endsWith('.tgs') ? 'sticker' :
        doc?.type === 'gif' ? 'gif' :
        doc?.type === 'voice' ? 'voice' :
        doc?.type === 'video' ? 'video' :
        doc?.type === 'audio' ? 'audio' :
        lower.endsWith('.mp4') ? 'gif' : 'file';
      body.existingFileUrl = path;
      putMediaOptions(body, media, captionEntities);
      const sent = await b.http.request('POST', path, body);
      if(peer) b.rememberSentConversation(peer, sent);
      return sent;
    }

    if(media._ === 'inputMediaContact') {
      const name = [media.first_name, media.last_name].filter(Boolean).join(' ');
      body.type = 'text';
      body.text = '👤 ' + name + '\n📞 ' + (media.phone_number || '');
      const contact: Json = {
        phone: media.phone_number || '',
        firstName: media.first_name || '',
        lastName: media.last_name || ''
      };
      const selfPhone = (b.usersManager.getSelf()?.phone || '').replace(/\D/g, '').replace(/^98/, '');
      if(selfPhone && (media.phone_number || '').replace(/\D/g, '').endsWith(selfPhone)) {
        contact.userId = b.selfMongoId;
      }

      body.contact = contact;
      const sent = await b.http.request('POST', path, body);
      if(peer) b.rememberSentConversation(peer, sent);
      return sent;
    }

    if(media._ === 'inputMediaGeoPoint' || media._ === 'inputMediaGeoLive' || media._ === 'inputMediaVenue') {
      const geo = media.geo_point;
      if(geo?._ !== 'inputGeoPoint') throw tlError(400, 'MEDIA_INVALID');
      body.type = media._ === 'inputMediaGeoLive' ? 'live_location' : 'location';
      body.location = {lat: geo.lat, lng: geo.long};
      const sent = await b.http.request('POST', path, body);
      if(peer) b.rememberSentConversation(peer, sent);
      return sent;
    }

    if(media._ === 'inputMediaPoll') {
      const poll = media.poll;
      body.type = 'poll';
      body.poll = {
        question: poll.question?.text || '',
        options: poll.answers.map((a) => (a as any).text?.text || ''),
        multiSelect: !!poll.pFlags?.multiple_choice,
        isAnonymous: !poll.pFlags?.public_voters
      };
      const sent = await b.http.request('POST', path, body);
      if(peer) b.rememberSentConversation(peer, sent);
      return sent;
    }

    let file: InputMedia.inputMediaUploadedDocument['file'];
    let mime: string;
    let fileName: string;
    let type: string;
    const meta: Json = {};
    if(media._ === 'inputMediaUploadedPhoto') {
      file = media.file;
      mime = 'image/jpeg';
      type = 'image';
    } else if(media._ === 'inputMediaUploadedDocument') {
      file = media.file;
      mime = media.mime_type || 'application/octet-stream';
      let voice = false, isVideo = false, animated = false, round = false;
      for(const attribute of media.attributes || []) {
        switch(attribute._) {
          case 'documentAttributeFilename':
            fileName = attribute.file_name;
            break;
          case 'documentAttributeAudio':
            if(attribute.pFlags?.voice) voice = true;
            if(attribute.duration) meta.duration = attribute.duration;
            if(attribute.waveform?.length) {
              let binary = '';
              attribute.waveform.forEach((byte) => binary += String.fromCharCode(byte));
              meta.waveform = btoa(binary);
            }

            if(attribute.title) meta.title = attribute.title;
            if(attribute.performer) meta.performer = attribute.performer;
            break;
          case 'documentAttributeVideo':
            isVideo = true;
            if(attribute.pFlags?.round_message) round = true;
            if(attribute.duration) meta.duration = attribute.duration;
            if(attribute.w) meta.width = attribute.w;
            if(attribute.h) meta.height = attribute.h;
            break;
          case 'documentAttributeImageSize':
            if(attribute.w) meta.width = attribute.w;
            if(attribute.h) meta.height = attribute.h;
            break;
          case 'documentAttributeAnimated':
            animated = true;
            break;
        }
      }

      if(voice) type = 'voice';
      else if(media.pFlags?.force_file) type = 'file';
      else if(round) type = 'video_note';
      // a video muted in the editor (and real GIFs) are "animated": a looping GIF
      else if(animated && (isVideo || mime.startsWith('video/') || mime === 'image/gif')) type = 'gif';
      else if(isVideo || mime.startsWith('video/')) type = 'video';
      else if(mime.startsWith('audio/')) type = 'audio';
      else if(mime.startsWith('image/') && mime !== 'image/webp') type = 'image';
      else type = 'file';
    } else {
      throw tlError(400, 'MEDIA_INVALID');
    }

    const blob = b.takeUpload(file, mime);
    if(!fileName) {
      const name = (file as {name?: string}).name;
      fileName = name && name.includes('.') ? name : 'file' + ({
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3'
      } as Record<string, string>)[mime] || '';
    }

    body.type = type;
    putMediaOptions(body, media, captionEntities);
    if(Object.keys(meta).length) body.mediaMeta = meta;
    const sent = await b.http.requestMultipart('POST', path, body, [{field: 'file', blob, fileName}]);
    if(peer) b.rememberSentConversation(peer, sent);
    return sent;
  };

  b.sendMediaMessage = sendOneMedia;

  const sentUpdates = (sent: Json[], peer: Peer, randomIds: (string | number)[]) => {
    const users: User[] = [];
    const updates: Update[] = [];
    sent.forEach((m, i) => {
      if(!m?._id) return;
      const message = b.buildAnyMessage(m, peer);
      b.addSender(m, users);
      if(randomIds[i] !== undefined) {
        updates.push({_: 'updateMessageID', id: message.id, random_id: randomIds[i]});
      }

      updates.push(b.newMessageUpdate(message));
    });

    return b.emptyUpdates(users, [], updates);
  };

  const deleteMessages = async(ids: number[], forEveryone: boolean) => {
    for(const id of ids) {
      const mongoId = await b.getMessageMongoId(id);
      if(!mongoId) continue;
      try {
        await b.http.request('DELETE', '/messages/' + mongoId + (forEveryone ? '' : '?forMe=1'));
      } catch(err) {
        b.log.error('delete message', err);
      }
    }

    return b.affectedMessages();
  };

  // POST /auth/report
  const sendReport = async(peer: InputPeer, messageMongoId: string, reason: string, comment: string) => {
    const body: Json = {reason: reason || 'other', source: 'web'};
    let description = comment || '';
    const userMongoId = peer && b.userTlIdOf(peer) !== undefined ? b.userMongoIdOf(peer) : undefined;
    if(userMongoId) {
      body.reportedUserId = userMongoId;
    } else if(peer) {
      const convId = await b.conversationIdOf(peer, false);
      if(convId) description = '[conversation ' + convId + '] ' + description;
    }

    if(messageMongoId) body.messageId = messageMongoId;
    body.description = description;
    await b.http.request('POST', '/auth/report', body).catch(() => {});
  };

  const readHistory = async(peer: InputPeer) => {
    const convId = await b.conversationIdOf(peer);
    if(convId) {
      try {
        await b.http.request('POST', '/messages/conversations/' + convId + '/read', {});
      } catch(err) {}
    }
  };

  const getMessagesByIds = async(ids: number[], fallbackPeer?: Peer): Promise<MessagesMessages> => {
    const users: User[] = [], chats: Chat[] = [];
    const messages: Message[] = [];
    const mongoIds = await b.getMessageMongoIds(ids);
    if(mongoIds.length) {
      const found = await b.http.requestArray('GET', '/messages/by-ids?ids=' + mongoIds.join(','));
      for(const m of found) {
        let peer = b.messagePeerForJson(m, fallbackPeer);
        if(!peer) {
          const convId = jsonStr(m, 'conversationId');
          peer = convId ? await b.fetchAndRegisterConversation(convId, users, chats).catch((): Peer => undefined) : undefined;
        }

        if(!peer) continue;
        messages.push(b.buildAnyMessage(m, peer));
        b.addSender(m, users);
      }
    }

    // ids the backend doesn't have (deleted) come back as messageEmpty
    const foundIds = new Set(messages.map((m) => m.id));
    for(const id of ids) {
      const serverId = getServerMessageId(id);
      if(!foundIds.has(serverId)) {
        messages.push({_: 'messageEmpty', id: serverId, ...(fallbackPeer ? {peer_id: fallbackPeer} : {})});
      }
    }

    for(const message of messages) {
      const peer = (message as Message.message).peer_id;
      if(peer?._ === 'peerChannel' && !chats.some((c) => c.id === peer.channel_id)) {
        const chat = b.chatsManager.getChat(peer.channel_id);
        if(chat) chats.push(chat);
      }
    }

    return {_: 'messages.messages', messages, topics: [], chats, users};
  };

  const pinnedMongoIds = (conv: Json) => {
    const ids: string[] = [];
    for(const p of Array.isArray(conv.pinnedMessages) ? conv.pinnedMessages : []) {
      const id = p && typeof(p) === 'object' ? String(p._id) : String(p);
      if(isMongoId(id) && !ids.includes(id)) ids.push(id);
    }

    return ids.sort().reverse(); // ObjectIds sort by time
  };

  const getUnreadMentions = async(peer: InputPeer, offsetId: number, addOffset: number, limit: number, minId?: number, maxId?: number) => {
    const convId = await b.conversationIdOf(peer);
    const tlPeer = b.peerFromInput(peer);
    if(!convId || !tlPeer) return buildMessagesResult([], tlPeer || {_: 'peerUser', user_id: 0}, 0);
    const response = await b.http.request('GET', '/conversations/' + convId + '/mentions?limit=100');
    const unread = +response.unread || 0;
    const list: Json[] = (Array.isArray(response.messages) ? response.messages : []).slice(0, unread);
    const all = list.filter((m) => {
      const id = idFromMongoIdInt32(String(m._id));
      if(offsetId && id >= offsetId && addOffset >= 0) return false;
      if(minId && id <= minId) return false;
      if(maxId && id >= maxId) return false;
      return true;
    });

    const result = buildMessagesResult(limit ? all.slice(0, limit) : all, tlPeer, list.length);
    for(const message of result.messages as Message.message[]) {
      message.pFlags.mentioned = true;
      message.pFlags.media_unread = true;
    }

    return result;
  };

  const search = async(peer: InputPeer, q: string, filter: MessagesFilter, offsetId: number, limit: number): Promise<MessagesMessages> => {
    const tlPeer = peer && peer._ !== 'inputPeerEmpty' ? b.peerFromInput(peer) : undefined;
    const empty = (): MessagesMessages => ({_: 'messages.messagesSlice', pFlags: {}, count: 0, messages: [], topics: [], chats: [], users: []});
    if(filter?._ === 'inputMessagesFilterPinned' && tlPeer) {
      const convId = await b.conversationIdOf(peer);
      if(!convId || offsetId) return empty();
      const conv = await b.http.request('GET', '/messages/conversations/' + convId);
      const ids = pinnedMongoIds(conv);
      if(!ids.length) return empty();
      const found = await b.http.requestArray('GET', '/messages/by-ids?ids=' + ids.join(','));
      const result = buildMessagesResult(found, tlPeer, found.length);
      for(const message of result.messages as Message.message[]) {
        message.pFlags.pinned = true;
      }

      return result;
    }

    if(filter?._ === 'inputMessagesFilterMyMentions' && tlPeer) {
      return getUnreadMentions(peer, offsetId, 0, limit);
    }

    const filterName = searchFilterName(filter);
    const query = (q || '').trim();
    if(filterName === 'none' || (!query && !filterName)) {
      return empty();
    }

    let path = '/messages/search?limit=' + Math.max(1, Math.min(limit || 20, MAX_PAGE));
    if(query) path += '&q=' + encodeURIComponent(query);
    if(filterName) path += '&filter=' + filterName;
    if(tlPeer) {
      const convId = await b.conversationIdOf(peer);
      if(!convId) return empty();
      path += '&conversationId=' + convId;
    }

    if(offsetId) {
      const before = await b.getMessageMongoId(offsetId);
      if(!before) return empty();
      path += '&before=' + before;
    }

    const response = await b.http.request('GET', path);
    const users: User[] = [], chats: Chat[] = [];
    const messages: AnyMessage[] = [];
    for(const m of Array.isArray(response.messages) ? response.messages : []) {
      let msgPeer = b.messagePeerForJson(m, tlPeer);
      if(!msgPeer) {
        const convId = jsonStr(m, 'conversationId');
        msgPeer = convId ? await b.fetchAndRegisterConversation(convId, users, chats).catch((): Peer => undefined) : undefined;
      }

      if(!msgPeer) continue;
      messages.push(b.buildMessage(m, msgPeer));
      b.addSender(m, users);
      if(msgPeer._ === 'peerChannel' && !chats.some((c) => c.id === msgPeer.channel_id)) {
        const chat = b.chatsManager.getChat(msgPeer.channel_id);
        if(chat) chats.push(chat);
      }
    }

    messages.sort((a, b) => b.id - a.id);
    return {
      _: 'messages.messagesSlice',
      pFlags: {},
      count: +response.count || messages.length,
      messages,
      topics: [],
      chats,
      users
    };
  };

  return {
    // ---------------------------------------------------------------- dialogs
    // the backend returns every conversation at once: there is no next page
    'messages.getDialogs': ({offset_date, offset_id, folder_id}) => {
      if(offset_date || offset_id) {
        return {_: 'messages.dialogs', dialogs: [], messages: [], chats: [], users: []};
      }

      return getDialogs(folder_id || 0);
    },

    'messages.getPinnedDialogs': () => ({
      _: 'messages.peerDialogs',
      dialogs: [],
      messages: [],
      chats: [],
      users: [],
      state: {_: 'updates.state', pts: 1, qts: 0, date: tsNow(true), seq: 0, unread_count: 0}
    }),

    'messages.getPeerDialogs': async({peers}) => {
      const result = {dialogs: [] as Dialog[], messages: [] as Message[], users: [] as User[], chats: [] as Chat[]};
      for(const inputDialogPeer of peers) {
        if(inputDialogPeer._ !== 'inputDialogPeer') continue;
        const convId = await b.conversationIdOf(inputDialogPeer.peer);
        if(!convId) continue;
        try {
          const conv = await b.http.request('GET', '/messages/conversations/' + convId);
          buildDialog(conv, result, idListContains(conv.archivedBy, b.selfMongoId) ? 1 : 0);
        } catch(err) {}
      }

      return {
        _: 'messages.peerDialogs',
        ...result,
        state: {_: 'updates.state', pts: 1, qts: 0, date: tsNow(true), seq: 0, unread_count: 0}
      };
    },

    'messages.getDialogFilters': () => ({_: 'messages.dialogFilters', pFlags: {}, filters: []}),
    'messages.updateDialogFilter': () => true,
    'messages.updateDialogFiltersOrder': () => true,
    'messages.getDialogUnreadMarks': () => [],
    'messages.markDialogUnread': () => true,
    // pins, folders, drafts... are kept by the app itself
    'messages.toggleDialogPin': () => true,
    'messages.reorderPinnedDialogs': () => true,
    'messages.saveDraft': () => true,
    'messages.getAllDrafts': () => b.emptyUpdates(),
    'messages.clearAllDrafts': () => true,
    'messages.hidePeerSettingsBar': () => true,
    'messages.getPeerSettings': () => ({
      _: 'messages.peerSettings',
      settings: {_: 'peerSettings', pFlags: {}},
      chats: [],
      users: []
    }),

    'folders.editPeerFolders': async({folder_peers}) => {
      for(const folderPeer of folder_peers) {
        const convId = await b.conversationIdOf(folderPeer.peer);
        if(!convId) continue;
        await b.http.request('PUT', '/settings/archive/' + convId, {archived: folderPeer.folder_id === 1}).catch(() => {});
      }

      return b.emptyUpdates([], [], folder_peers.map((folderPeer) => ({
        _: 'updateFolderPeers',
        folder_peers: [{
          _: 'folderPeer',
          peer: b.peerFromInput(folderPeer.peer),
          folder_id: folderPeer.folder_id
        }],
        pts: 0,
        pts_count: 0
      })));
    },

    // ---------------------------------------------------------------- history
    'messages.getHistory': async({peer, offset_id, add_offset, limit}) => {
      const tlPeer = b.peerFromInput(peer);
      const convId = await b.conversationIdOf(peer);
      if(!convId || !tlPeer) {
        return buildMessagesResult([], tlPeer || {_: 'peerUser', user_id: 0}, 0);
      }

      const list = await getHistoryJson(convId, offset_id, add_offset, limit);
      return buildMessagesResult(list, tlPeer);
    },

    'messages.getMessages': ({id}) => {
      const ids = id.filter((i) => i._ === 'inputMessageID').map((i) => (i as {id: number}).id);
      return getMessagesByIds(ids);
    },

    'channels.getMessages': ({channel, id}) => {
      const ids = id.filter((i) => i._ === 'inputMessageID').map((i) => (i as {id: number}).id);
      const chatTlId = b.chatTlIdOf(channel);
      return getMessagesByIds(ids, chatTlId ? {_: 'peerChannel', channel_id: chatTlId} : undefined);
    },

    // ---------------------------------------------------------------- sending
    'messages.sendMessage': async(params) => {
      if(params.quick_reply_shortcut) {
        return b.sendToQuickReply(params.quick_reply_shortcut, [params]);
      }

      const body: Json = {type: 'text', text: params.message};
      await b.putMessageTarget(body, params.peer);
      if(params.no_webpage) body.noLinkPreview = true;
      const formatting = b.entitiesToJson(params.entities);
      if(formatting.length) body.entities = formatting;
      await putReplyTo(body, params.reply_to);

      let sent: Json;
      try {
        sent = await b.http.request('POST', '/messages', body);
      } catch(err) {
        throw err instanceof RestException ? restError(err.statusCode, err.serverMessage) : err;
      }

      b.rememberSentConversation(params.peer, sent);
      const id = b.rememberMessageId(String(sent._id));
      const tlPeer = b.peerFromInput(params.peer);
      if(tlPeer?._ === 'peerChannel') b.ensureChannelState(+tlPeer.channel_id);

      // the app replaces the sent message's entities with these: they must be
      // the ones the server copy gets (clickable links + the sender's formatting)
      const entities = b.detectEntities(params.message);
      entities.push(...b.entitiesFromJson(sent.entities));
      entities.sort((a, b) => a.offset - b.offset);
      const media = params.no_webpage ? undefined : b.buildWebPageMedia(sent.linkPreview);
      return {
        _: 'updateShortSentMessage',
        pFlags: {out: true},
        id,
        pts: 0,
        pts_count: 0,
        date: parseIsoToEpochSeconds(sent.createdAt),
        ...(media ? {media} : {}),
        ...(entities.length ? {entities} : {})
      };
    },

    'messages.sendMedia': async(params) => {
      if(params.quick_reply_shortcut) {
        return b.sendToQuickReply(params.quick_reply_shortcut, [params]);
      }

      if(params.media._ === 'inputMediaWebPage') {
        return b.invoke('messages.sendMessage', {
          peer: params.peer,
          message: params.message,
          entities: params.entities,
          reply_to: params.reply_to,
          random_id: params.random_id
        }, {});
      }

      const sent = await sendOneMedia(params.peer, params.media, params.message, params.reply_to, params.entities).catch((err) => {
        throw err instanceof RestException ? restError(err.statusCode, err.serverMessage) : err;
      });
      return sentUpdates([sent], b.peerFromInput(params.peer), [params.random_id]);
    },

    'messages.sendMultiMedia': async(params) => {
      if(params.quick_reply_shortcut) {
        return b.sendToQuickReply(params.quick_reply_shortcut, params.multi_media);
      }

      const sent: Json[] = [];
      for(const single of params.multi_media) {
        sent.push(await sendOneMedia(params.peer, single.media, single.message, params.reply_to, single.entities));
      }

      return sentUpdates(sent, b.peerFromInput(params.peer), params.multi_media.map((single) => single.random_id));
    },

    'messages.forwardMessages': async(params) => {
      const toConversationId = await b.conversationIdOf(params.to_peer);
      const body: Json = {};
      if(toConversationId) {
        body.conversationId = toConversationId;
      } else {
        await b.putMessageTarget(body, params.to_peer);
      }

      const sent: Json[] = [];
      for(const id of params.id) {
        const messageMongoId = await b.getMessageMongoId(id);
        if(!messageMongoId) continue;
        const forwarded = await b.http.request('POST', '/messages/forward', {...body, messageId: messageMongoId});
        b.rememberSentConversation(params.to_peer, forwarded);
        sent.push(forwarded);
      }

      return sentUpdates(sent, b.peerFromInput(params.to_peer), params.random_id);
    },

    'messages.editMessage': async(params) => {
      if(params.quick_reply_shortcut_id) {
        const response = await b.http.request('PUT', '/business/quick-replies/' + params.quick_reply_shortcut_id + '/messages/' + params.id, {
          text: params.message || '',
          entities: b.entitiesToJson(params.entities)
        }).catch(() => {
          throw tlError(400, 'MESSAGE_ID_INVALID');
        });
        const m: Json = response.message || {};
        const message = b.buildMessage({
          ...m,
          _id: ('000000000000000000000000' + (+m.id || 0).toString(16)).slice(-24),
          sender: b.selfMongoId
        }, {_: 'peerUser', user_id: b.selfTlId});
        message.id = +m.id || params.id;
        message.pFlags.out = true;
        message.quick_reply_shortcut_id = params.quick_reply_shortcut_id;
        return b.emptyUpdates([], [], [{_: 'updateQuickReplyMessage', message}]);
      }

      const mongoId = await b.getMessageMongoId(params.id);
      if(!mongoId) throw tlError(400, 'MESSAGE_ID_INVALID');
      const body: Json = {};
      if(params.message !== undefined) {
        body.text = params.message;
        body.entities = b.entitiesToJson(params.entities);
      }

      const edited = await b.http.request('PUT', '/messages/' + mongoId, body).catch((err) => {
        throw err instanceof RestException ? restError(err.statusCode, err.serverMessage) : err;
      });
      const peer = b.peerFromInput(params.peer);
      const users: User[] = [];
      b.addSender(edited, users);
      return b.emptyUpdates(users, [], [b.editMessageUpdate(b.buildAnyMessage(edited, peer))]);
    },

    'messages.getMessageEditData': () => ({_: 'messages.messageEditData', pFlags: {}}),

    // ---------------------------------------------------------------- deleting
    // "also delete for <name>" (revoke) removes it for everyone, otherwise only for me
    'messages.deleteMessages': ({id, revoke}) => deleteMessages(id, !!revoke),
    // groups / channels: always for everyone
    'channels.deleteMessages': ({channel, id}) => {
      const chatTlId = b.chatTlIdOf(channel);
      if(chatTlId) b.ensureChannelState(chatTlId);
      return deleteMessages(id, true);
    },

    'messages.deleteHistory': async({peer, revoke}) => {
      const convId = await b.conversationIdOf(peer);
      if(convId) {
        await b.http.request('DELETE', '/conversations/' + convId + (revoke ? '' : '?forMe=1'));
      }

      return b.affectedHistory();
    },

    'channels.deleteHistory': async({channel}) => {
      const convId = b.chatConversationIdOf(channel);
      if(convId) {
        await b.http.request('DELETE', '/conversations/' + convId + '?forMe=1').catch(() => {});
      }

      return b.emptyUpdates();
    },

    // ---------------------------------------------------------------- read state
    'messages.readHistory': async({peer}) => {
      await readHistory(peer);
      return b.affectedMessages();
    },

    'channels.readHistory': async({channel}) => {
      await readHistory({_: 'inputPeerChannel', channel_id: b.chatTlIdOf(channel), access_hash: (channel as any).access_hash});
      return true;
    },

    'messages.readMessageContents': async({id}) => {
      for(const tlId of id) {
        const mongoId = await b.getMessageMongoId(tlId);
        if(mongoId && b.viewOnceMessages.delete(mongoId)) {
          // view-once media was opened: the backend deletes it
          b.http.request('POST', '/messages/' + mongoId + '/view_once', {}).catch(() => {});
        }
      }

      return b.affectedMessages();
    },

    'channels.readMessageContents': async({id}) => {
      for(const tlId of id) {
        const mongoId = await b.getMessageMongoId(tlId);
        if(mongoId && b.viewOnceMessages.delete(mongoId)) {
          b.http.request('POST', '/messages/' + mongoId + '/view_once', {}).catch(() => {});
        }
      }

      return true;
    },

    'messages.readMentions': async({peer}) => {
      const convId = await b.conversationIdOf(peer);
      if(convId) {
        await b.http.request('POST', '/conversations/' + convId + '/mentions/read', {}).catch(() => {});
      }

      return b.affectedHistory();
    },

    'messages.readReactions': () => b.affectedHistory(),
    'messages.getUnreadMentions': ({peer, offset_id, add_offset, limit, min_id, max_id}) => {
      return getUnreadMentions(peer, offset_id, add_offset, limit, min_id, max_id);
    },

    'messages.getOutboxReadDate': async({peer, msg_id}) => {
      const mongoId = await b.getMessageMongoId(msg_id);
      if(mongoId) {
        const list = await b.http.requestArray('GET', '/messages/' + mongoId + '/read-participants').catch((): Json[] => []);
        const other = list.find((r) => jsonStr(r, 'userId') && jsonStr(r, 'userId') !== b.selfMongoId);
        if(other) {
          return {_: 'outboxReadDate', date: parseIsoToEpochSeconds(other.date)};
        }
      }

      throw tlError(400, 'MESSAGE_NOT_READ_YET');
    },

    'messages.getMessageReadParticipants': async({msg_id}) => {
      const mongoId = await b.getMessageMongoId(msg_id);
      if(!mongoId) return [];
      const list = await b.http.requestArray('GET', '/messages/' + mongoId + '/read-participants').catch((): Json[] => []);
      return list.filter((r) => isMongoId(jsonStr(r, 'userId'))).map((r) => {
        const userId = String(r.userId);
        const tlId = idFromMongoId(userId);
        b.rememberUser(tlId, userId);
        return {_: 'readParticipantDate', user_id: tlId, date: parseIsoToEpochSeconds(r.date)};
      });
    },

    // ---------------------------------------------------------------- typing
    'messages.setTyping': async({peer, action}) => {
      const convId = await b.conversationIdOf(peer, false);
      if(convId && b.selfMongoId) {
        const cancel = action?._ === 'sendMessageCancelAction';
        const self = b.usersManager.getSelf();
        b.socket.emit(cancel ? 'stop_typing' : 'typing', {
          conversationId: convId,
          userId: b.selfMongoId,
          ...(cancel ? {} : {name: self?.first_name || ''})
        });
      }

      return true;
    },

    // ---------------------------------------------------------------- reactions
    'messages.sendReaction': async({peer, msg_id, reaction}) => {
      const mongoId = await b.getMessageMongoId(msg_id);
      if(!mongoId) throw tlError(400, 'MESSAGE_ID_INVALID');
      let emoji: string;
      const first = reaction?.[0];
      if(first?._ === 'reactionEmoji') {
        emoji = first.emoticon;
      } else if(first?._ === 'reactionCustomEmoji') {
        // premium emoji reaction: stored by its file so every client can render it
        const path = b.relativeUploadPath(b.getMediaUrl(first.document_id));
        if(path) emoji = 'custom:' + path;
      } else if(!reaction?.length) {
        // the backend toggles: re-sending my current one removes it
        emoji = b.myReactionByMessage.get(mongoId);
      }

      if(!emoji) {
        return b.emptyUpdates();
      }

      const updated = await b.http.request('POST', '/messages/' + mongoId + '/react', {emoji});
      b.rememberMyReaction(mongoId, updated.reactions);
      return b.emptyUpdates([], [], [b.reactionsUpdate(b.peerFromInput(peer), getServerMessageId(msg_id), updated.reactions)]);
    },

    'messages.getMessagesReactions': async({peer, id}) => {
      const tlPeer = b.peerFromInput(peer);
      const updates: Update[] = [];
      const mongoIds = await b.getMessageMongoIds(id);
      if(mongoIds.length) {
        const found = await b.http.requestArray('GET', '/messages/by-ids?ids=' + mongoIds.join(',')).catch((): Json[] => []);
        for(const m of found) {
          b.rememberMyReaction(String(m._id), m.reactions);
          updates.push(b.reactionsUpdate(tlPeer, idFromMongoIdInt32(String(m._id)), m.reactions));
        }
      }

      return b.emptyUpdates([], [], updates);
    },

    'messages.getMessageReactionsList': async({id, reaction, offset, limit}) => {
      const mongoId = await b.getMessageMongoId(id);
      const users: User[] = [];
      const reactions: MessagePeerReaction[] = [];
      if(mongoId && !offset) {
        let only: string;
        if(reaction?._ === 'reactionEmoji') {
          only = reaction.emoticon;
        } else if(reaction?._ === 'reactionCustomEmoji') {
          const path = b.relativeUploadPath(b.getMediaUrl(reaction.document_id));
          only = path ? 'custom:' + path : '-';
        }

        const list = await b.http.requestArray('GET', '/messages/' + mongoId + '/reactions-list').catch((): Json[] => []);
        for(const r of list) {
          const emoji = jsonStr(r, 'emoji') || '';
          if(only && only !== emoji) continue;
          if(!r.user?._id) continue;
          const user = b.buildUser(r.user);
          b.addUserOnce(users, user);
          reactions.push({
            _: 'messagePeerReaction',
            pFlags: String(r.user._id) === b.selfMongoId ? {my: true} : {},
            peer_id: {_: 'peerUser', user_id: +user.id},
            date: parseIsoToEpochSeconds(r.date),
            reaction: emoji.startsWith('custom:') ? {
              _: 'reactionCustomEmoji',
              document_id: b.registerMedia(b.absoluteUrl(emoji.slice('custom:'.length)))
            } : {_: 'reactionEmoji', emoticon: emoji}
          });
        }
      }

      return {
        _: 'messages.messageReactionsList',
        count: reactions.length,
        reactions: limit ? reactions.slice(0, limit) : reactions,
        chats: [],
        users
      };
    },

    'messages.getPollVotes': async({id, option, offset, limit}) => {
      const mongoId = await b.getMessageMongoId(id);
      const users: User[] = [];
      const votes: MessagePeerVote[] = [];
      if(mongoId && !offset) {
        const only = option?.length ? new TextDecoder().decode(option instanceof Uint8Array ? option : new Uint8Array(option as any)) : undefined;
        const list = await b.http.requestArray('GET', '/messages/' + mongoId + '/poll-voters').catch((): Json[] => []);
        for(const v of list) {
          const optionId = String(v.optionId ?? '');
          if(only !== undefined && only !== optionId) continue;
          if(!v.user?._id) continue;
          const user = b.buildUser(v.user);
          b.addUserOnce(users, user);
          votes.push({
            _: 'messagePeerVote',
            peer: {_: 'peerUser', user_id: +user.id},
            option: new TextEncoder().encode(optionId),
            date: tsNow(true)
          });
        }
      }

      return {
        _: 'messages.votesList',
        count: votes.length,
        votes: limit ? votes.slice(0, limit) : votes,
        chats: [],
        users
      };
    },

    // ---------------------------------------------------------------- pins / polls
    'messages.updatePinnedMessage': async({peer, id, unpin}) => {
      const convId = await b.requireConversationIdOf(peer);
      const messageMongoId = await b.getMessageMongoId(id);
      if(!messageMongoId) throw tlError(400, 'MESSAGE_ID_INVALID');
      await b.http.request('PUT', '/conversations/' + convId + '/pin', {
        messageId: messageMongoId,
        action: unpin ? 'unpin' : 'pin'
      });
      return b.emptyUpdates([], [], [b.pinUpdate(b.peerFromInput(peer), [getServerMessageId(id)], !unpin)]);
    },

    'messages.unpinAllMessages': async({peer}) => {
      const convId = await b.conversationIdOf(peer);
      if(convId) {
        await b.http.request('PUT', '/conversations/' + convId + '/pin', {action: 'unpin_all'}).catch(() => {});
      }

      return b.affectedHistory();
    },

    'messages.sendVote': async({peer, msg_id, options}) => {
      const mongoId = await b.getMessageMongoId(msg_id);
      if(!mongoId || !options?.length) throw tlError(400, 'MESSAGE_ID_INVALID');
      const option = options[0];
      const optionId = new TextDecoder().decode(option instanceof Uint8Array ? option : new Uint8Array(option as any));
      const updated = await b.http.request('POST', '/messages/' + mongoId + '/poll/vote', {optionId});
      const users: User[] = [];
      b.addSender(updated, users);
      return b.emptyUpdates(users, [], [b.editMessageUpdate(b.buildAnyMessage(updated, b.peerFromInput(peer)))]);
    },

    // ---------------------------------------------------------------- search
    'messages.search': ({peer, q, filter, offset_id, limit}) => search(peer, q, filter, offset_id, limit),
    'messages.searchGlobal': ({q, filter, offset_id, limit}) => search(undefined, q, filter, offset_id, limit),

    'messages.getSearchCounters': async({peer, filters}) => {
      const convId = await b.conversationIdOf(peer);
      const counters = [];
      for(const filter of filters) {
        let count = 0;
        const name = searchFilterName(filter);
        if(convId && name && name !== 'none') {
          const response = await b.http.request('GET', '/messages/search?limit=1&filter=' + name + '&conversationId=' + convId).catch((): Json => ({}));
          count = +response.count || 0;
        }

        counters.push({_: 'messages.searchCounter' as const, pFlags: {}, filter, count});
      }

      return counters;
    },

    // ---------------------------------------------------------------- channel comments
    // the post's copy ("anchor") in the linked discussion group is the thread
    // root; comments are group messages replying to it
    'messages.getDiscussionMessage': async({peer, msg_id}) => {
      const postMongoId = await b.getMessageMongoId(msg_id);
      if(!postMongoId) throw tlError(400, 'MSG_ID_INVALID');
      let response: Json;
      try {
        response = await b.http.request('GET', '/messages/discussion/' + postMongoId);
      } catch(err) {
        throw tlError(400, 'MSG_ID_INVALID');
      }

      const group: Json = response.group, anchor: Json = response.anchor;
      if(!group?._id || !anchor?._id) throw tlError(400, 'MSG_ID_INVALID');
      const chats: Chat[] = [], users: User[] = [];
      const channelMongoId = jsonStr(response, 'channelId');
      const groupTlId = idFromMongoId(String(group._id));
      if(isMongoId(channelMongoId)) b.linkedChatMongoIdByTlId.set(groupTlId, channelMongoId);
      const groupPeer = b.registerConversationChat(group, chats);
      const channelTlId = b.chatTlIdOf(peer);
      const channel = channelTlId && b.chatsManager.getChat(channelTlId);
      if(channel) chats.push(channel);
      const root = b.buildMessage(anchor, groupPeer);
      b.addSender(anchor, users);
      b.ensureChannelState(groupTlId);
      return {
        _: 'messages.discussionMessage',
        messages: [root],
        max_id: root.id,
        read_inbox_max_id: root.id,
        read_outbox_max_id: root.id,
        unread_count: 0,
        chats,
        users
      };
    },

    'messages.getReplies': async({peer, msg_id, offset_id, add_offset, limit}) => {
      const tlPeer = b.peerFromInput(peer);
      const anchorMongoId = await b.getMessageMongoId(msg_id);
      if(!anchorMongoId || (add_offset < 0 && offset_id)) {
        return buildMessagesResult([], tlPeer, 0);
      }

      let path = '/messages/replies/' + anchorMongoId + '?limit=' + Math.max(1, Math.min(limit || 20, MAX_PAGE));
      if(offset_id) {
        const before = await b.getMessageMongoId(offset_id);
        if(before) path += '&before=' + before;
      }

      const response = await b.http.request('GET', path);
      const list: Json[] = Array.isArray(response.messages) ? response.messages : [];
      return buildMessagesResult(list, tlPeer, +response.count || list.length);
    },

    'messages.readDiscussion': () => true,

    'messages.getMessagesViews': async({id, increment}) => {
      const viewsByMongo: Map<string, number> = new Map();
      const mongoIds = await b.getMessageMongoIds(id);
      if(mongoIds.length) {
        const counts = await b.http.requestArray('POST', '/messages/views', {ids: mongoIds, increment: !!increment}).catch((): Json[] => []);
        for(const c of counts) {
          viewsByMongo.set(String(c._id), +c.views || 0);
        }
      }

      const views = [];
      for(const tlId of id) {
        const mongoId = await b.getMessageMongoId(tlId);
        const count = mongoId ? viewsByMongo.get(mongoId) : undefined;
        views.push({_: 'messageViews' as const, ...(count !== undefined ? {views: Math.max(1, count)} : {})});
      }

      return {_: 'messages.messageViews', views, chats: [], users: []};
    },

    // ---------------------------------------------------------------- misc
    'messages.getWebPagePreview': async({message}) => {
      const lp = await b.http.request('POST', '/messages/link-preview', {text: message || ''}).catch((): Json => undefined);
      const media = b.buildWebPageMedia(lp);
      return {
        _: 'messages.webPagePreview',
        media: media || {_: 'messageMediaEmpty'},
        chats: [],
        users: []
      };
    },

    'messages.setHistoryTTL': async({peer, period}) => {
      const convId = await b.requireConversationIdOf(peer);
      await b.http.request('PUT', '/conversations/' + convId + '/ttl', {period});
      return b.emptyUpdates();
    },

    'messages.report': async({peer, id, option, message}) => {
      const chosen = option?.length ? new TextDecoder().decode(option instanceof Uint8Array ? option : new Uint8Array(option as any)) : '';
      if(!chosen) {
        return {
          _: 'reportResultChooseOption',
          title: 'Report',
          options: REPORT_OPTIONS.map(([key, text]) => ({
            _: 'messageReportOption' as const,
            text,
            option: new TextEncoder().encode(key)
          }))
        };
      }

      if(chosen === 'other' && !message) {
        return {_: 'reportResultAddComment', pFlags: {}, option: new TextEncoder().encode(chosen)};
      }

      const messageMongoId = id?.length ? await b.getMessageMongoId(id[0]) : undefined;
      await sendReport(peer, messageMongoId, chosen, message);
      return {_: 'reportResultReported'};
    },

    'messages.reportSpam': async({peer}) => {
      await sendReport(peer, undefined, 'spam', '');
      return true;
    },

    'account.reportPeer': async({peer, message}) => {
      await sendReport(peer, undefined, 'profile', message);
      return true;
    },

    'messages.getSponsoredMessages': async() => {
      const ads = await b.http.requestArray('GET', '/ads/public', undefined, false).catch((): Json[] => []);
      const messages = ads.filter((ad) => ad.isActive !== false).map((ad) => ({
        _: 'sponsoredMessage' as const,
        pFlags: {},
        random_id: new TextEncoder().encode(String(ad._id)),
        url: String(ad.link || ''),
        title: String(ad.title || ''),
        message: String(ad.description || ''),
        button_text: 'Learn More',
        ...(jsonStr(ad, 'imageUrl') ? {photo: b.buildPhoto(b.absoluteUrl(ad.imageUrl))} : {})
      }));
      return messages.length ? {
        _: 'messages.sponsoredMessages',
        pFlags: {},
        messages,
        chats: [],
        users: []
      } : {_: 'messages.sponsoredMessagesEmpty'};
    },
    'messages.viewSponsoredMessage': () => true,
    'messages.clickSponsoredMessage': () => true,

    // ---------------------------------------------------------------- catch-up
    // Realtime updates come over the socket; after a reconnect this replays
    // messages sent meanwhile (newer than the last known date).
    'updates.getDifference': async({date}): Promise<UpdatesDifference> => {
      const now = tsNow(true);
      const state = {_: 'updates.state' as const, pts: 1, qts: 0, date: now, seq: 0, unread_count: 0};
      if(!date || now - date > MAX_DIFFERENCE_AGE || !b.isAuthorized()) {
        return {_: 'updates.differenceEmpty', date: now, seq: 0};
      }

      const conversations = await b.http.requestArray('GET', '/messages/conversations').catch((): Json[] => []);
      const users: User[] = [], chats: Chat[] = [];
      const newMessages: AnyMessage[] = [];
      const otherUpdates: Update[] = [];
      for(const conv of conversations) {
        const last: Json = conv.lastMessage;
        if(!last?._id || parseIsoToEpochSeconds(last.createdAt) <= date) continue;
        const peer = b.registerConversation(conv, users, chats);
        if(!peer) continue;
        let page: Json[] = [];
        try {
          page = await fetchPage(String(conv._id), 50);
        } catch(err) {
          page = [last];
        }

        for(const m of page) {
          if(parseIsoToEpochSeconds(m.createdAt) <= date || b.http.wasSentByThisClient(String(m._id))) continue;
          const message = b.buildAnyMessage(m, peer);
          b.addSender(m, users);
          if(peer._ === 'peerChannel') {
            otherUpdates.push(b.newMessageUpdate(message));
          } else {
            newMessages.push(message);
          }
        }
      }

      if(!newMessages.length && !otherUpdates.length) {
        return {_: 'updates.differenceEmpty', date: now, seq: 0};
      }

      for(const chat of chats) {
        if(chat._ === 'channel') b.ensureChannelState(+chat.id);
      }

      return {
        _: 'updates.difference',
        new_messages: newMessages,
        new_encrypted_messages: [],
        other_updates: otherUpdates,
        chats,
        users,
        state
      };
    }
  };
}
