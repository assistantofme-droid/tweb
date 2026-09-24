/*
 * Groups and channels (both TL channels): creating, joining, leaving,
 * members, admins and their rights, bans / restrictions, permissions,
 * settings, invite links, join requests, discussion groups, the admin log.
 */

import type {
  Chat,
  ChannelAdminLogEvent,
  ChannelAdminLogEventAction,
  ChannelParticipant,
  ChatBannedRights,
  ChatFull,
  ChatInviteImporter,
  ChatReactions,
  ExportedChatInvite,
  InputChannel,
  InputPeer,
  Peer,
  Photo,
  Reaction,
  User
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import tsNow from '@helpers/tsNow';
import {RestException, tlError, toTlError} from '@lib/sevenNine/errors';
import {idFromMongoId, isMongoId, parseIsoToEpochSeconds} from '@lib/sevenNine/ids';
import {SITE_LINK} from '@lib/sevenNine/links';
import {idListContains, jsonStr, refId} from '@lib/sevenNine/restBridge';

const USERNAME_REGEXP = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

export default function chatsHandlers(b: RestBridge): BridgeHandlers {
  /** the member route, or (not a member: a public preview) the messages route */
  const fetchConversation = async(convId: string): Promise<Json> => {
    try {
      return await b.http.request('GET', '/conversations/' + convId);
    } catch(err) {
      return b.http.request('GET', '/messages/conversations/' + convId);
    }
  };

  const requireConvId = (input: InputChannel | InputPeer | number) => {
    const convId = b.chatConversationIdOf(input);
    if(!convId) throw tlError(400, 'CHANNEL_INVALID');
    return convId;
  };

  const requireUserMongoId = (input: any) => {
    const mongoId = b.userMongoIdOf(input);
    if(!mongoId) throw tlError(400, 'USER_ID_INVALID');
    return mongoId;
  };

  const rethrow = (err: any): never => {
    throw toTlError(err);
  };

  /** the conversation again, as updates carrying the fresh chat */
  const freshChatUpdates = async(convId: string) => {
    const chats: Chat[] = [];
    try {
      const peer = b.registerConversationChat(await fetchConversation(convId), chats);
      return b.emptyUpdates([], chats, [{_: 'updateChannel', channel_id: (peer as Peer.peerChannel).channel_id}]);
    } catch(err) {
      return b.emptyUpdates();
    }
  };

  const conversationCall = async(input: InputChannel | InputPeer, method: string, suffix: string, body?: Json) => {
    const convId = requireConvId(input);
    try {
      await b.http.request(method, '/conversations/' + convId + suffix, body);
    } catch(err) {
      rethrow(err);
    }

    return convId;
  };

  const groupSetting = async(input: InputChannel | InputPeer, key: string, value: any) => {
    const convId = requireConvId(input);
    try {
      await b.http.request('PUT', '/conversations/' + convId + '/settings', {[key]: value});
    } catch(err) {
      throw tlError(403, 'CHAT_ADMIN_REQUIRED');
    }

    return freshChatUpdates(convId);
  };

  const buildInvite = (code: string, revoked = false): ExportedChatInvite.chatInviteExported => ({
    _: 'chatInviteExported',
    pFlags: revoked ? {permanent: true, revoked: true} : {permanent: true},
    link: SITE_LINK + 'invite/' + code,
    admin_id: b.selfTlId,
    date: tsNow(true)
  });

  const inviteCodeFromHash = (hash: string) => {
    hash = hash || '';
    const i = hash.lastIndexOf('/');
    return (i >= 0 ? hash.slice(i + 1) : hash).replace(/^\+/, '');
  };

  const availableReactionsFor = (conv: Json): ChatReactions => {
    const r: Json = conv.availableReactions;
    if(!r || r.type === 'all') return {_: 'chatReactionsAll', pFlags: {allow_custom: true}};
    if(r.type === 'none') return {_: 'chatReactionsNone'};
    const reactions: Reaction[] = [];
    for(const v of Array.isArray(r.list) ? r.list : []) {
      const value = String(v || '');
      if(value.startsWith('custom:')) {
        reactions.push({_: 'reactionCustomEmoji', document_id: b.registerMedia(b.absoluteUrl(value.slice('custom:'.length)))});
      } else if(value) {
        reactions.push({_: 'reactionEmoji', emoticon: value});
      }
    }

    return {_: 'chatReactionsSome', reactions};
  };

  const pinnedMongoIds = (conv: Json) => {
    const ids: string[] = [];
    for(const p of Array.isArray(conv.pinnedMessages) ? conv.pinnedMessages : []) {
      const id = p && typeof(p) === 'object' ? String(p._id) : String(p);
      if(isMongoId(id) && !ids.includes(id)) ids.push(id);
    }

    return ids.sort().reverse();
  };

  /** the participant object the UI expects for a member (creator, admin or plain) */
  const participantFor = (conv: Json, userId: string, userTlId: number, date: number): ChannelParticipant => {
    const ownerId = refId(conv, 'owner');
    const rights = b.adminRightsFor(conv, userId);
    const rank = b.customTitleFor(conv, userId);
    if(userId === ownerId) {
      return {
        _: 'channelParticipantCreator',
        user_id: userTlId,
        admin_rights: rights || b.fullAdminRights(),
        ...(rank ? {rank} : {})
      };
    }

    if(rights) {
      const promotedBy = b.promotedByFor(conv, userId) || ownerId;
      const mine = b.adminRightsFor(conv, b.selfMongoId);
      const selfOwner = b.selfMongoId === ownerId;
      const canEdit = selfOwner || (mine?.pFlags.add_admins && b.selfMongoId === promotedBy);
      const promotedByTlId = isMongoId(promotedBy) ? idFromMongoId(promotedBy) : 0;
      return {
        _: 'channelParticipantAdmin',
        pFlags: {
          ...(canEdit ? {can_edit: true as const} : {}),
          ...(userId === b.selfMongoId ? {self: true as const} : {})
        },
        user_id: userTlId,
        inviter_id: promotedByTlId,
        promoted_by: promotedByTlId,
        date,
        admin_rights: rights,
        ...(rank ? {rank} : {})
      };
    }

    return {_: 'channelParticipant', user_id: userTlId, date};
  };

  const bannedParticipant = (userTlId: number, date: number, kickedBy: number, rights: ChatBannedRights.chatBannedRights, left: boolean): ChannelParticipant.channelParticipantBanned => ({
    _: 'channelParticipantBanned',
    pFlags: left ? {left: true} : {},
    peer: {_: 'peerUser', user_id: userTlId},
    kicked_by: kickedBy,
    date,
    banned_rights: rights
  });

  const joinResult = async(convId: string) => {
    b.socket.joinConversation(convId);
    return {
      _: 'messages.chatInviteJoinResultOk' as const,
      updates: await freshChatUpdates(convId)
    };
  };

  // ---------------------------------------------------------------- admin log
  const getAdminLog = async(channel: InputChannel, q: string, admins: any[], filter: any): Promise<Json> => {
    const convId = requireConvId(channel);
    const channelTlId = b.chatTlIdOf(channel);
    const channelPeer: Peer = {_: 'peerChannel', channel_id: channelTlId};
    const adminFilter = new Set((admins || []).map((u) => b.userTlIdOf(u)).filter(Boolean));
    const query = (q || '').trim().toLowerCase();
    const f = filter?.pFlags;
    const events: ChannelAdminLogEvent[] = [];
    const users: User[] = [];
    const logs = await b.http.requestArray('GET', '/conversations/' + convId + '/admin-logs');
    const participant = (p: ChannelParticipant) => p;
    for(const log of logs) {
      if(events.length >= 300) break;
      const actor: Json = log.actor;
      if(!actor?._id) continue;
      const target: Json = log.targetUser?._id ? log.targetUser : undefined;
      const data: Json = log.data || {};
      const type = String(log.actionType || '');
      const details = String(log.details || '');
      const actorId = idFromMongoId(String(actor._id));
      const targetId = target ? idFromMongoId(String(target._id)) : 0;
      if(adminFilter.size && !adminFilter.has(actorId)) continue;
      if(query) {
        const hay = (details + ' ' + (actor.name || '') + ' ' + (target?.name || '')).toLowerCase();
        if(!hay.includes(query)) continue;
      }

      const date = parseIsoToEpochSeconds(log.timestamp);
      let userId = actorId;
      let action: ChannelAdminLogEventAction;
      let passes = true;
      const messageFromLog = (m: Json) => b.buildMessage({...m, conversationId: convId}, channelPeer);
      switch(type) {
        case 'member_joined':
          if(!targetId || targetId === actorId) {
            action = {_: 'channelAdminLogEventActionParticipantJoin'};
            passes = !f || !!f.join;
          } else {
            action = {_: 'channelAdminLogEventActionParticipantInvite', participant: participant({_: 'channelParticipant', user_id: targetId, date})};
            passes = !f || !!f.invite;
          }
          break;
        case 'member_left':
          action = {_: 'channelAdminLogEventActionParticipantLeave'};
          passes = !f || !!f.leave;
          break;
        case 'member_kicked':
        case 'member_banned':
        case 'restriction_added':
        case 'restriction_removed': {
          if(!targetId) continue;
          const removed = type === 'restriction_removed';
          const full = type !== 'restriction_added';
          const rights: ChatBannedRights.chatBannedRights = {
            _: 'chatBannedRights',
            pFlags: full ? {view_messages: true} : {send_messages: true, send_media: true},
            until_date: 0x7FFFFFFF
          };
          const member = participant({_: 'channelParticipant', user_id: targetId, date});
          const restricted = bannedParticipant(targetId, date, actorId, rights, full);
          action = {
            _: 'channelAdminLogEventActionParticipantToggleBan',
            prev_participant: removed ? restricted : member,
            new_participant: removed ? member : restricted
          };
          passes = !f || (removed ? !!(f.unban || f.unkick) : !!(f.ban || f.kick));
          break;
        }
        case 'permission_change':
        case 'ownership_transfer': {
          if(!targetId) continue;
          const owner = type === 'ownership_transfer';
          const promoted = owner || details.toLowerCase().includes('promot');
          const admin: ChannelParticipant = {
            _: 'channelParticipantAdmin',
            pFlags: {},
            user_id: targetId,
            promoted_by: actorId,
            date,
            admin_rights: b.fullAdminRights()
          };
          const plain = participant({_: 'channelParticipant', user_id: targetId, date});
          const after: ChannelParticipant = owner ?
            {_: 'channelParticipantCreator', user_id: targetId, admin_rights: b.fullAdminRights()} :
            (promoted ? admin : plain);
          action = {
            _: 'channelAdminLogEventActionParticipantToggleAdmin',
            prev_participant: owner ? admin : (promoted ? plain : admin),
            new_participant: after
          };
          passes = !f || (promoted ? !!f.promote : !!f.demote);
          break;
        }
        case 'message_deleted': {
          const m: Json = data.message || {
            _id: log._id,
            text: details,
            type: 'text',
            createdAt: log.timestamp
          };
          if(!m.sender && target) m.sender = target._id;
          action = {_: 'channelAdminLogEventActionDeleteMessage', message: messageFromLog(m)};
          passes = !f || !!f.delete;
          break;
        }
        case 'message_edited': {
          const messageId = jsonStr(data, 'messageId');
          if(!messageId) continue;
          const base: Json = {
            _id: messageId,
            type: data.type || 'text',
            createdAt: data.createdAt || log.timestamp,
            ...(target ? {sender: target._id} : {})
          };
          action = {
            _: 'channelAdminLogEventActionEditMessage',
            prev_message: messageFromLog({...base, text: data.prevText || ''}),
            new_message: messageFromLog({...base, text: data.newText || '', isEdited: true, updatedAt: log.timestamp})
          };
          passes = !f || !!f.edit;
          break;
        }
        case 'message_pinned':
        case 'message_unpinned': {
          const messageId = jsonStr(data, 'messageId');
          let m: Json;
          if(messageId) {
            const found = await b.http.requestArray('GET', '/messages/by-ids?ids=' + messageId).catch((): Json[] => []);
            m = found[0];
          }

          m ||= {
            _id: messageId || log._id,
            text: details,
            type: 'text',
            createdAt: log.timestamp,
            sender: actor._id
          };
          const message = messageFromLog(m);
          if(type === 'message_pinned') message.pFlags.pinned = true;
          action = {_: 'channelAdminLogEventActionUpdatePinned', message};
          passes = !f || !!f.pinned;
          break;
        }
        case 'join_request_approved':
          if(!targetId) continue;
          userId = targetId;
          action = {
            _: 'channelAdminLogEventActionParticipantJoinByRequest',
            invite: {...buildInvite(''), link: SITE_LINK, admin_id: actorId},
            approved_by: actorId
          };
          passes = !f || !!(f.join || f.invites);
          break;
        case 'slow_mode_changed':
        case 'slow_mode_updated': {
          const parsed = details.match(/(\d+)/);
          action = {
            _: 'channelAdminLogEventActionToggleSlowMode',
            prev_value: +data.prev || 0,
            new_value: 'new' in data ? +data.new || 0 : (parsed ? +parsed[1] : 0)
          };
          passes = !f || !!f.settings;
          break;
        }
        case 'title_changed':
          action = {_: 'channelAdminLogEventActionChangeTitle', prev_value: String(data.prev || ''), new_value: String(data.new || '')};
          passes = !f || !!f.info;
          break;
        case 'about_changed':
          action = {_: 'channelAdminLogEventActionChangeAbout', prev_value: String(data.prev || ''), new_value: String(data.new || '')};
          passes = !f || !!f.info;
          break;
        case 'username_changed':
          action = {_: 'channelAdminLogEventActionChangeUsername', prev_value: String(data.prev || ''), new_value: String(data.new || '')};
          passes = !f || !!f.info;
          break;
        case 'photo_changed': {
          const photo = (url: string): Photo => url ? b.buildPhoto(b.absoluteUrl(url)) : {_: 'photoEmpty', id: '0'};
          action = {_: 'channelAdminLogEventActionChangePhoto', prev_photo: photo(jsonStr(data, 'prev')), new_photo: photo(jsonStr(data, 'new'))};
          passes = !f || !!f.info;
          break;
        }
        case 'permissions_changed':
          action = {
            _: 'channelAdminLogEventActionDefaultBannedRights',
            prev_banned_rights: b.defaultBannedRights(data.prev),
            new_banned_rights: b.defaultBannedRights(data.new)
          };
          passes = !f || !!f.settings;
          break;
        default:
          continue;
      }

      if(!passes || !action) continue;
      events.push({_: 'channelAdminLogEvent', id: String(idFromMongoId(String(log._id))), date, user_id: userId, action});
      for(const u of [actor, target]) {
        if(!u) continue;
        const known = b.usersManager.getUser(idFromMongoId(String(u._id)));
        b.addUserOnce(users, known?._ === 'user' ? known : b.buildUser(u));
      }
    }

    return {_: 'channels.adminLogResults', events, chats: [], users};
  };

  return {
    // ---------------------------------------------------------------- create / join / leave
    'messages.createChat': async({users, title}) => {
      const participants = users.map((u) => b.userMongoIdOf(u)).filter(Boolean);
      const conv = await b.http.request('POST', '/conversations/group', {type: 'group', name: title, participants}).catch(rethrow);
      const chats: Chat[] = [];
      b.registerConversationChat(conv, chats);
      b.socket.joinConversation(String(conv._id));
      return {_: 'messages.invitedUsers', updates: b.emptyUpdates([], chats), missing_invitees: []};
    },

    'channels.createChannel': async({title, about, megagroup}) => {
      const body: Json = {type: megagroup ? 'group' : 'channel', name: title};
      if(about) body.description = about;
      const conv = await b.http.request('POST', '/conversations/group', body).catch(rethrow);
      const chats: Chat[] = [];
      b.registerConversationChat(conv, chats);
      b.socket.joinConversation(String(conv._id));
      return b.emptyUpdates([], chats);
    },

    'channels.joinChannel': async({channel}) => {
      const convId = await conversationCall(channel, 'POST', '/join', {});
      return joinResult(convId);
    },

    'channels.leaveChannel': async({channel}) => {
      const convId = b.chatConversationIdOf(channel);
      if(convId) {
        await b.http.request('POST', '/conversations/' + convId + '/leave', {}).catch(rethrow);
      }

      return b.emptyUpdates();
    },

    'messages.deleteChat': async({chat_id}) => {
      const convId = b.chatConversationIdOf(+chat_id);
      if(convId) await b.http.request('POST', '/conversations/' + convId + '/leave', {}).catch(() => {});
      return true;
    },

    'channels.deleteChannel': async({channel}) => {
      await conversationCall(channel, 'DELETE', '');
      return b.emptyUpdates();
    },

    'channels.getChannels': async({id}) => {
      const chats: Chat[] = [];
      for(const input of id) {
        const convId = b.chatConversationIdOf(input);
        if(!convId) continue;
        try {
          b.registerConversationChat(await fetchConversation(convId), chats);
        } catch(err) {}
      }

      return {_: 'messages.chats', chats};
    },

    'messages.getChats': async({id}) => {
      const chats: Chat[] = [];
      for(const chatId of id) {
        const convId = b.chatConversationIdOf(+chatId);
        if(!convId) continue;
        try {
          b.registerConversationChat(await fetchConversation(convId), chats);
        } catch(err) {}
      }

      return {_: 'messages.chats', chats};
    },

    // ---------------------------------------------------------------- members
    'messages.addChatUser': async({chat_id, user_id}) => {
      const convId = requireConvId(+chat_id);
      await b.http.request('POST', '/conversations/' + convId + '/members', {userId: requireUserMongoId(user_id)}).catch(rethrow);
      return {_: 'messages.invitedUsers', updates: b.emptyUpdates(), missing_invitees: []};
    },

    'channels.inviteToChannel': async({channel, users}) => {
      const convId = requireConvId(channel);
      for(const u of users) {
        const userId = b.userMongoIdOf(u);
        if(!userId) continue;
        await b.http.request('POST', '/conversations/' + convId + '/members', {userId}).catch(() => {});
      }

      return {_: 'messages.invitedUsers', updates: await freshChatUpdates(convId), missing_invitees: []};
    },

    'messages.deleteChatUser': async({chat_id, user_id}) => {
      const convId = requireConvId(+chat_id);
      const userId = requireUserMongoId(user_id);
      if(userId === b.selfMongoId) {
        await b.http.request('POST', '/conversations/' + convId + '/leave', {}).catch(rethrow);
      } else {
        await b.http.request('DELETE', '/conversations/' + convId + '/members/' + userId).catch(rethrow);
      }

      return b.emptyUpdates();
    },

    'channels.getParticipants': async({channel, filter, offset, limit}) => {
      const convId = requireConvId(channel);
      const conv = await fetchConversation(convId);
      const ownerId = refId(conv, 'owner');
      const now = tsNow(true);
      const users: User[] = [];
      const all: ChannelParticipant[] = [];
      const q = String((filter as {q?: string})?.q || '').trim().toLowerCase();
      const matches = (u: Json) => !q || ((u.name || '') + ' ' + (u.username || '')).toLowerCase().includes(q);
      if(filter?._ === 'channelParticipantsKicked' || filter?._ === 'channelParticipantsBanned') {
        const kicked = filter._ === 'channelParticipantsKicked';
        for(const entry of Array.isArray(conv[kicked ? 'bannedUsers' : 'restrictedUsers']) ? conv[kicked ? 'bannedUsers' : 'restrictedUsers'] : []) {
          const userJson: Json = entry?.user;
          if(!userJson?._id || !matches(userJson)) continue;
          const user = b.buildUser(userJson);
          b.addUserOnce(users, user);
          let rights: ChatBannedRights.chatBannedRights;
          if(kicked) {
            const until = jsonStr(entry, 'until');
            const untilDate = until ? parseIsoToEpochSeconds(until) : 0;
            rights = {
              _: 'chatBannedRights',
              pFlags: {view_messages: true, send_messages: true, send_media: true},
              // far-future dates mean "forever"
              until_date: untilDate > now + 10 * 365 * 86400 ? 0 : untilDate
            };
          } else {
            rights = b.restrictionRights(entry);
          }

          all.push(bannedParticipant(+user.id, now, isMongoId(ownerId) ? idFromMongoId(ownerId) : 0, rights, kicked));
        }
      } else {
        for(const p of Array.isArray(conv.participants) ? conv.participants : []) {
          if(!p?._id) continue;
          const id = String(p._id);
          const isAdmin = id === ownerId || idListContains(conv.admins, id);
          if(filter?._ === 'channelParticipantsAdmins' && !isAdmin) continue;
          if(filter?._ === 'channelParticipantsBots' && !p.isBot) continue;
          if(filter?._ === 'channelParticipantsContacts' && !b.contactMongoIds.has(id)) continue;
          if(!matches(p)) continue;
          const user = b.buildUser(p);
          b.addUserOnce(users, user);
          all.push(participantFor(conv, id, +user.id, now));
        }
      }

      const from = Math.max(0, offset || 0);
      return {
        _: 'channels.channelParticipants',
        count: all.length,
        participants: all.slice(from, limit ? from + limit : undefined),
        chats: [],
        users
      };
    },

    'channels.getParticipant': async({channel, participant}) => {
      const convId = requireConvId(channel);
      const userId = b.userMongoIdOf(participant);
      if(!userId) throw tlError(400, 'USER_NOT_PARTICIPANT');
      const conv = await fetchConversation(convId);
      const found = (Array.isArray(conv.participants) ? conv.participants : []).find((p: Json) => p && String(p._id) === userId);
      if(!found) throw tlError(400, 'USER_NOT_PARTICIPANT');
      const user = b.buildUser(found);
      const joined = parseIsoToEpochSeconds(conv.createdAt);
      const restriction = b.activeRestriction(conv, userId);
      return {
        _: 'channels.channelParticipant',
        participant: restriction && !b.adminRightsFor(conv, userId) ?
          bannedParticipant(+user.id, joined, 0, b.restrictionRights(restriction), false) :
          participantFor(conv, userId, +user.id, joined),
        chats: [],
        users: [user]
      };
    },

    'messages.getOnlines': async({peer}) => {
      const convId = b.chatConversationIdOf(peer);
      let onlines = 0;
      if(convId) {
        const conv = await fetchConversation(convId).catch((): Json => ({}));
        onlines = (Array.isArray(conv.participants) ? conv.participants : []).filter((p: Json) => p?.isOnline).length;
      }

      return {_: 'chatOnlines', onlines};
    },

    // ---------------------------------------------------------------- admins
    'channels.editAdmin': async({channel, user_id, admin_rights, rank}) => {
      const convId = requireConvId(channel);
      try {
        await b.http.request('PUT', '/conversations/' + convId + '/admin-rights', {
          userId: requireUserMongoId(user_id),
          rights: b.adminRightsToJson(admin_rights),
          rank: rank || ''
        });
      } catch(err) {
        if(err instanceof RestException) {
          throw tlError(400, /^[A-Z_]+$/.test(err.serverMessage || '') ? err.serverMessage : 'CHAT_ADMIN_REQUIRED');
        }

        throw err;
      }

      // fresh chat so our own rights / the admin list update right away
      return freshChatUpdates(convId);
    },

    'messages.editChatAdmin': async({chat_id, user_id, is_admin}) => {
      const convId = requireConvId(+chat_id);
      await b.http.request('PUT', '/conversations/' + convId + '/admins', {userId: requireUserMongoId(user_id), isAdmin: !!is_admin}).catch(rethrow);
      return true;
    },

    // ---------------------------------------------------------------- bans / restrictions
    'channels.editBanned': async({channel, participant, banned_rights}) => {
      const convId = requireConvId(channel);
      const userId = requireUserMongoId(participant);
      const pFlags = banned_rights?.pFlags || {};
      const perms = b.bannedRightsToPermissions(banned_rights);
      const anyLimit = Object.values(perms).some((allowed) => !allowed);
      try {
        if(pFlags.view_messages) {
          const body: Json = {userId};
          if(banned_rights.until_date > 0) body.customDate = banned_rights.until_date * 1000;
          await b.http.request('POST', '/conversations/' + convId + '/ban', body);
        } else if(!anyLimit) {
          // lifts both a ban ("removed users") and a restriction
          await b.http.request('POST', '/conversations/' + convId + '/unban', {userId}).catch(() => {});
          await b.http.request('POST', '/conversations/' + convId + '/unrestrict', {userId}).catch(() => {});
        } else {
          const body: Json = {userId, restrictions: perms};
          if(banned_rights.until_date > 0) body.until = banned_rights.until_date * 1000;
          await b.http.request('POST', '/conversations/' + convId + '/restrict', body);
        }
      } catch(err) {
        rethrow(err);
      }

      return freshChatUpdates(convId);
    },

    // for everyone (unlike editBanned, which targets one member)
    'messages.editChatDefaultBannedRights': async({peer, banned_rights}) => {
      const convId = requireConvId(peer);
      await b.http.request('PUT', '/conversations/' + convId + '/permissions', {defaultPermissions: b.bannedRightsToPermissions(banned_rights)}).catch(rethrow);
      return freshChatUpdates(convId);
    },

    'channels.deleteParticipantHistory': async({channel, participant}) => {
      const convId = requireConvId(channel);
      const userId = requireUserMongoId(participant);
      let deleted = 0;
      try {
        const response = await b.http.request('POST', '/conversations/' + convId + '/delete-user-messages', {userId});
        deleted = +response.deleted || 0;
      } catch(err) {
        throw tlError(403, 'CHAT_ADMIN_REQUIRED');
      }

      return {_: 'messages.affectedHistory', pts: 0, pts_count: deleted, offset: 0};
    },

    'channels.reportSpam': async({channel, participant}) => {
      const userId = b.userMongoIdOf(participant);
      if(userId) {
        await b.http.request('POST', '/auth/report', {
          reportedUserId: userId,
          reason: 'spam',
          description: '[conversation ' + b.chatConversationIdOf(channel) + '] spam in group'
        }).catch(() => {});
      }

      return true;
    },

    // ---------------------------------------------------------------- info / settings
    'channels.editTitle': async({channel, title}) => {
      const convId = await conversationCall(channel, 'PUT', '', {name: title});
      return freshChatUpdates(convId);
    },

    'messages.editChatTitle': async({chat_id, title}) => {
      const convId = await conversationCall({_: 'inputPeerChannel', channel_id: chat_id, access_hash: b.chatConversationIdOf(+chat_id)}, 'PUT', '', {name: title});
      return freshChatUpdates(convId);
    },

    'messages.editChatAbout': async({peer, about}) => {
      await conversationCall(peer, 'PUT', '', {description: about || ''});
      return true;
    },

    // PUT /conversations/:id/edit (multipart "avatar"), or clearing it
    'channels.editPhoto': async({channel, photo}) => {
      const convId = requireConvId(channel);
      let conv: Json;
      try {
        if(photo?._ === 'inputChatUploadedPhoto' && photo.file) {
          const blob = b.takeUpload(photo.file);
          conv = await b.http.requestMultipart('PUT', '/conversations/' + convId + '/edit', {}, [{field: 'avatar', blob, fileName: 'avatar.jpg'}]);
        } else {
          conv = await b.http.request('PUT', '/conversations/' + convId, {avatar: ''});
        }
      } catch(err) {
        rethrow(err);
      }

      const chats: Chat[] = [];
      if(conv?._id) b.registerConversationChat(conv, chats);
      return b.emptyUpdates([], chats, [{_: 'updateChannel', channel_id: b.chatTlIdOf(channel)}]);
    },

    // a member's custom title ("rank")
    'messages.editChatParticipantRank': async({peer, participant, rank}) => {
      const convId = await conversationCall(peer, 'PUT', '/custom-title', {
        userId: b.userMongoIdOf(participant) || '',
        customTitle: rank || ''
      });
      return freshChatUpdates(convId);
    },

    // not on this backend: accepted, nothing changes
    'channels.toggleAntiSpam': () => b.emptyUpdates(),
    'channels.toggleAutotranslation': () => b.emptyUpdates(),

    'channels.toggleSlowMode': async({channel, seconds}) => {
      const convId = await conversationCall(channel, 'PUT', '/slow-mode', {slowModeInterval: seconds});
      return freshChatUpdates(convId);
    },

    'channels.toggleJoinRequest': async({channel, enabled}) => {
      const convId = await conversationCall(channel, 'PUT', '', {approveNewMembers: !!enabled});
      return freshChatUpdates(convId);
    },

    'messages.toggleNoForwards': async({peer, enabled}) => {
      const convId = await conversationCall(peer, 'PUT', '', {protectedContent: !!enabled});
      return freshChatUpdates(convId);
    },

    'channels.toggleSignatures': async(params) => {
      const enabled = !!(params as any).signatures_enabled;
      const convId = await conversationCall(params.channel, 'PUT', '', {showSignatures: enabled});
      return freshChatUpdates(convId);
    },

    'channels.togglePreHistoryHidden': ({channel, enabled}) => groupSetting(channel, 'hiddenPrehistory', !!enabled),
    'channels.toggleParticipantsHidden': ({channel, enabled}) => groupSetting(channel, 'participantsHidden', !!enabled),
    'channels.toggleJoinToSend': ({channel, enabled}) => groupSetting(channel, 'joinToSend', !!enabled),

    'messages.setChatAvailableReactions': ({peer, available_reactions}) => {
      let value: Json;
      if(available_reactions?._ === 'chatReactionsNone') {
        value = {type: 'none'};
      } else if(available_reactions?._ === 'chatReactionsSome') {
        const list: string[] = [];
        for(const r of available_reactions.reactions) {
          if(r._ === 'reactionEmoji') list.push(r.emoticon);
          else if(r._ === 'reactionCustomEmoji') {
            const path = b.relativeUploadPath(b.getMediaUrl(r.document_id));
            if(path) list.push('custom:' + path);
          }
        }

        value = {type: 'some', list};
      } else {
        value = {type: 'all'};
      }

      return groupSetting(peer, 'availableReactions', value);
    },

    'channels.checkUsername': async({channel, username}) => {
      if(!USERNAME_REGEXP.test(username || '')) throw tlError(400, 'USERNAME_INVALID');
      const ownConvId = b.chatConversationIdOf(channel);
      try {
        const existing = await b.http.request('GET', '/conversations/handle/' + encodeURIComponent(username));
        const id = jsonStr(existing, '_id');
        return !id || id === ownConvId;
      } catch(err) {
        if(err instanceof RestException && err.statusCode === 404) return true;
        throw err;
      }
    },

    'channels.updateUsername': async({channel, username}) => {
      if(username && !USERNAME_REGEXP.test(username)) throw tlError(400, 'USERNAME_INVALID');
      const body: Json = {handle: username || ''};
      if(username) body.isPrivateLink = false;
      try {
        await conversationCall(channel, 'PUT', '', body);
      } catch(err) {
        const message = String((err as ApiError)?.message || '').toLowerCase();
        if(message.includes('taken')) throw tlError(400, 'USERNAME_OCCUPIED');
        throw err;
      }

      return true;
    },

    'channels.toggleUsername': () => true,
    'channels.reorderUsernames': () => true,
    'channels.deactivateAllUsernames': () => true,

    'channels.updateColor': async(params) => {
      const convId = requireConvId(params.channel);
      const body: Json = {forProfile: !!params.for_profile, color: params.color ?? -1};
      if(params.background_emoji_id) body.backgroundEmojiId = String(params.background_emoji_id);
      try {
        await b.http.request('PUT', '/conversations/' + convId + '/appearance', body);
      } catch(err) {
        throw tlError(403, 'BOOSTS_REQUIRED');
      }

      return freshChatUpdates(convId);
    },

    // channel "levels" unlock appearance settings; here a blue tick does
    'premium.getBoostsStatus': ({peer}) => {
      const chatTlId = b.chatTlIdOf(peer);
      const chat = chatTlId && b.chatsManager.getChat(chatTlId) as Chat.channel;
      const unlocked = !!chat?.pFlags?.verified;
      return {
        _: 'premium.boostsStatus',
        pFlags: {},
        level: unlocked ? 10 : 0,
        current_level_boosts: unlocked ? 100 : 0,
        boosts: unlocked ? 100 : 0,
        next_level_boosts: unlocked ? 100 : 1,
        boost_url: SITE_LINK
      };
    },

    // ---------------------------------------------------------------- full info
    'channels.getFullChannel': async({channel}) => {
      const convId = requireConvId(channel);
      const conv = await fetchConversation(convId).catch(rethrow);
      const chats: Chat[] = [];
      const users: User[] = [];
      const channelChat = b.buildChannel(conv, b.chatTlIdOf(channel));
      chats.push(channelChat);
      const isCreator = !!channelChat.pFlags.creator;
      const isAdmin = !!channelChat.admin_rights;
      const participants: Json[] = Array.isArray(conv.participants) ? conv.participants : [];
      for(const p of participants) {
        if(p?._id) b.addUserOnce(users, b.buildUser(p));
      }

      const full: ChatFull.channelFull = {
        _: 'channelFull',
        pFlags: {},
        id: channelChat.id,
        about: String(conv.description || ''),
        read_inbox_max_id: 0,
        read_outbox_max_id: 0,
        unread_count: 0,
        chat_photo: b.buildFullChatPhoto(conv),
        notify_settings: {_: 'peerNotifySettings'},
        bot_info: [],
        pts: 1,
        available_reactions: availableReactionsFor(conv),
        participants_count: participants.length,
        admins_count: Array.isArray(conv.admins) ? conv.admins.length : 0,
        online_count: participants.filter((p) => p?.isOnline).length
      };

      const pFlags = full.pFlags;
      if(isCreator || channelChat.admin_rights?.pFlags.change_info) pFlags.can_set_username = true;
      pFlags.stories_pinned_available = true;
      if(conv.hiddenPrehistory) pFlags.hidden_prehistory = true;
      if(conv.participantsHidden) pFlags.participants_hidden = true;
      if(isAdmin || !conv.participantsHidden) pFlags.can_view_participants = true;
      if(isAdmin) {
        full.kicked_count = Array.isArray(conv.bannedUsers) ? conv.bannedUsers.length : 0;
        full.banned_count = Array.isArray(conv.restrictedUsers) ? conv.restrictedUsers.length : 0;
      }

      if(+conv.slowModeInterval > 0) full.slowmode_seconds = +conv.slowModeInterval;
      const pins = pinnedMongoIds(conv);
      if(pins.length) full.pinned_msg_id = b.rememberMessageId(pins[0]);

      if(isCreator || channelChat.admin_rights?.pFlags.invite_users) {
        let code = jsonStr(conv, 'inviteCode');
        if(!code) {
          const invite = await b.http.request('GET', '/conversations/' + convId + '/invite').catch((): Json => ({}));
          code = jsonStr(invite, 'inviteCode');
        }

        if(code) full.exported_invite = buildInvite(code);
        if(conv.approveNewMembers) {
          const pending = await b.http.requestArray('GET', '/conversations/' + convId + '/pending-requests').catch((): Json[] => []);
          if(pending.length) {
            full.requests_pending = pending.length;
            full.recent_requesters = pending.slice(0, 3).map((pr) => refId(pr, 'userId')).filter(isMongoId).map((id) => {
              const tlId = idFromMongoId(id);
              b.rememberUser(tlId, id);
              return tlId;
            });
          }
        }
      }

      // linked discussion group <-> channel (comments)
      const linkedId = refId(conv, 'linkedDiscussionGroupId') || refId(conv, 'discussionForChannelId');
      if(isMongoId(linkedId)) {
        try {
          const linkedPeer = b.registerConversationChat(await fetchConversation(linkedId), chats);
          full.linked_chat_id = (linkedPeer as Peer.peerChannel).channel_id;
        } catch(err) {}
      }

      // commands of the bots in this group ("/" menu)
      for(const p of participants) {
        if(!p?.isBot) continue;
        try {
          const botJson = await b.http.request('GET', '/auth/users/' + p._id);
          b.addUserOnce(users, b.buildUser(botJson));
          full.bot_info.push({
            _: 'botInfo',
            pFlags: {},
            user_id: idFromMongoId(String(p._id)),
            commands: (Array.isArray(botJson.botCommands) ? botJson.botCommands : [])
            .filter((c: Json) => jsonStr(c, 'command'))
            .map((c: Json) => ({
              _: 'botCommand' as const,
              pFlags: {},
              command: String(c.command).replace(/^\//, ''),
              description: String(c.description || '')
            }))
          });
        } catch(err) {}
      }

      b.ensureChannelState(+channelChat.id);
      return {_: 'messages.chatFull', full_chat: full, chats, users};
    },

    // ---------------------------------------------------------------- invite links
    // one permanent link per chat on this backend
    'messages.exportChatInvite': async({peer}) => {
      const convId = requireConvId(peer);
      const response = await b.http.request('GET', '/conversations/' + convId + '/invite').catch(rethrow);
      return buildInvite(jsonStr(response, 'inviteCode') || '');
    },

    'messages.getExportedChatInvites': async({peer, revoked}) => {
      const convId = b.chatConversationIdOf(peer);
      const invites: ExportedChatInvite[] = [];
      if(convId && !revoked) {
        const response = await b.http.request('GET', '/conversations/' + convId + '/invite').catch((): Json => ({}));
        const code = jsonStr(response, 'inviteCode');
        if(code) invites.push(buildInvite(code));
      }

      return {_: 'messages.exportedChatInvites', count: invites.length, invites, users: []};
    },

    'messages.getExportedChatInvite': async({peer}) => {
      const convId = requireConvId(peer);
      const response = await b.http.request('GET', '/conversations/' + convId + '/invite').catch(rethrow);
      return {_: 'messages.exportedChatInvite', invite: buildInvite(jsonStr(response, 'inviteCode') || ''), users: []};
    },

    'messages.editExportedChatInvite': async({peer, revoked}) => {
      const convId = requireConvId(peer);
      if(revoked) {
        const old = await b.http.request('GET', '/conversations/' + convId + '/invite').catch(rethrow);
        const fresh = await b.http.request('POST', '/conversations/' + convId + '/invite/revoke', {}).catch(rethrow);
        return {
          _: 'messages.exportedChatInviteReplaced',
          invite: buildInvite(jsonStr(old, 'inviteCode') || '', true),
          new_invite: buildInvite(jsonStr(fresh, 'inviteCode') || ''),
          users: []
        };
      }

      const response = await b.http.request('GET', '/conversations/' + convId + '/invite').catch(rethrow);
      return {_: 'messages.exportedChatInvite', invite: buildInvite(jsonStr(response, 'inviteCode') || ''), users: []};
    },

    'messages.deleteExportedChatInvite': () => true,
    'messages.deleteRevokedExportedChatInvites': () => true,

    'messages.getAdminsWithInvites': () => {
      const self = b.usersManager.getSelf();
      return {
        _: 'messages.chatAdminsWithInvites',
        admins: b.selfMongoId ? [{_: 'chatAdminWithInvites', admin_id: b.selfTlId, invites_count: 1, revoked_invites_count: 0}] : [],
        users: self ? [self] : []
      };
    },

    'messages.checkChatInvite': async({hash}) => {
      const code = inviteCodeFromHash(hash);
      const info = await b.http.request('GET', '/conversations/invite/' + code).catch(() => {
        throw tlError(400, 'INVITE_HASH_INVALID');
      });

      const convId = jsonStr(info, '_id') || jsonStr(info, 'conversationId');
      if(isMongoId(convId) && idListContains(info.participants, b.selfMongoId)) {
        const chats: Chat[] = [];
        b.registerConversationChat({...info, _id: convId}, chats);
        return {_: 'chatInviteAlready', chat: chats[0]};
      }

      const isChannel = info.type === 'channel';
      const avatar = jsonStr(info, 'avatar');
      return {
        _: 'chatInvite',
        pFlags: {
          ...(isChannel ? {channel: true as const, broadcast: true as const} : {channel: true as const, megagroup: true as const}),
          ...(info.approveNewMembers ? {request_needed: true as const} : {})
        },
        title: String(info.name || (isChannel ? 'Channel' : 'Group')),
        ...(jsonStr(info, 'description') ? {about: String(info.description)} : {}),
        photo: avatar ? b.buildPhoto(b.absoluteUrl(avatar)) : {_: 'photoEmpty', id: '0'},
        participants_count: +info.participantsCount || 0,
        color: 0
      };
    },

    'messages.importChatInvite': async({hash}) => {
      const code = inviteCodeFromHash(hash);
      const conv = await b.http.request('POST', '/conversations/invite/' + code + '/join', {}).catch(rethrow);
      const chats: Chat[] = [];
      b.registerConversationChat(conv, chats);
      b.socket.joinConversation(String(conv._id));
      return {
        _: 'messages.chatInviteJoinResultOk' as const,
        updates: b.emptyUpdates([], chats)
      };
    },

    // ---------------------------------------------------------------- join requests
    'messages.getChatInviteImporters': async({peer, requested}) => {
      const convId = b.chatConversationIdOf(peer);
      const users: User[] = [];
      const importers: ChatInviteImporter[] = [];
      if(convId && requested) {
        const list = await b.http.requestArray('GET', '/conversations/' + convId + '/pending-requests').catch((): Json[] => []);
        for(const r of list) {
          const userJson: Json = r.userId;
          if(!userJson?._id) continue;
          const user = b.buildUser(userJson);
          b.addUserOnce(users, user);
          importers.push({
            _: 'chatInviteImporter',
            pFlags: {requested: true},
            user_id: user.id,
            date: parseIsoToEpochSeconds(r.requestedAt)
          });
        }
      }

      return {_: 'messages.chatInviteImporters', count: importers.length, importers, users};
    },

    'messages.hideChatJoinRequest': async({peer, user_id, approved}) => {
      const convId = requireConvId(peer);
      await b.http.request('POST', '/conversations/' + convId + (approved ? '/approve-request' : '/decline-request'), {userId: requireUserMongoId(user_id)}).catch(rethrow);
      return freshChatUpdates(convId);
    },

    'messages.hideAllChatJoinRequests': async({peer, approved}) => {
      const convId = requireConvId(peer);
      const pending = await b.http.requestArray('GET', '/conversations/' + convId + '/pending-requests').catch((): Json[] => []);
      const userIds = pending.map((p) => refId(p, 'userId')).filter(isMongoId);
      if(userIds.length) {
        await b.http.request('POST', '/conversations/' + convId + (approved ? '/approve-request' : '/decline-request'), {userIds}).catch(rethrow);
      }

      return freshChatUpdates(convId);
    },

    // ---------------------------------------------------------------- discussion groups
    'channels.setDiscussionGroup': async({broadcast, group}) => {
      const channelId = b.chatConversationIdOf(broadcast);
      if(!channelId) throw tlError(400, 'BROADCAST_ID_INVALID');
      const groupId = group && group._ !== 'inputChannelEmpty' ? b.chatConversationIdOf(group) : undefined;
      if(groupId) {
        await b.http.request('POST', '/conversations/' + channelId + '/link-discussion', {discussionGroupId: groupId}).catch(rethrow);
      } else {
        await b.http.request('POST', '/conversations/' + channelId + '/unlink-discussion', {}).catch(rethrow);
      }

      return true;
    },

    'channels.getGroupsForDiscussion': async() => {
      const conversations = await b.http.requestArray('GET', '/messages/conversations').catch((): Json[] => []);
      const chats: Chat[] = [];
      for(const conv of conversations) {
        if(conv.type !== 'group') continue;
        if(refId(conv, 'owner') !== b.selfMongoId && !b.isSelfAdmin(conv)) continue;
        b.registerConversationChat(conv, chats);
      }

      return {_: 'messages.chats', chats};
    },

    // my own public groups / channels (personal channel picker, username limits)
    'channels.getAdminedPublicChannels': async() => {
      const conversations = await b.http.requestArray('GET', '/messages/conversations').catch((): Json[] => []);
      const chats: Chat[] = [];
      for(const conv of conversations) {
        if(conv.type !== 'channel' && conv.type !== 'group') continue;
        if(refId(conv, 'owner') !== b.selfMongoId) continue;
        if(!jsonStr(conv, 'handle') || conv.isPrivateLink) continue;
        b.registerConversationChat(conv, chats);
      }

      return {_: 'messages.chats', chats};
    },

    'channels.getChannelRecommendations': () => ({_: 'messages.chats', chats: []}),
    'channels.getInactiveChannels': () => ({_: 'messages.inactiveChats', dates: [], chats: [], users: []}),
    'channels.getSendAs': () => ({_: 'channels.sendAsPeers', peers: [], chats: [], users: []}),

    'channels.exportMessageLink': async({channel, id}) => {
      const chatTlId = b.chatTlIdOf(channel);
      const chat = b.chatsManager.getChat(chatTlId) as Chat.channel;
      const where = chat?.username || b.chatConversationIdOf(channel);
      const messageMongoId = await b.getMessageMongoId(id);
      const link = SITE_LINK + (chat?.pFlags?.megagroup ? 'gp/' : 'cl/') + where + (messageMongoId ? '?msg=' + messageMongoId : '');
      return {_: 'exportedMessageLink', link, html: ''};
    },

    'channels.getAdminLog': ({channel, q, admins, events_filter, max_id}) => {
      if(max_id) {
        // everything comes in the first page
        return {_: 'channels.adminLogResults', events: [], chats: [], users: []};
      }

      return getAdminLog(channel, q, admins, events_filter) as any;
    }
  };
}
